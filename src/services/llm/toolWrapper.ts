/**
 * Tool Calling Wrapper for Ollama
 * 
 * Provides function/tool calling support for Ollama models that don't have
 * native tool_use support. Converts Anthropic-style tool definitions to a
 * prompt-based format and parses responses to extract tool calls.
 * 
 * Strategy:
 * 1. Inject tool definitions into system prompt with clear XML format
 * 2. Parse model output for tool call patterns
 * 3. Convert extracted calls to Anthropic tool_use format
 * 4. Handle tool results in follow-up messages
 */

import type { LLMMessage, MessageContent, LLMRequestOptions } from './types.js'

/**
 * Tool definition in Anthropic format
 */
export interface ToolDefinition {
  name: string
  description: string
  input_schema: {
    type: 'object'
    properties?: Record<string, {
      type: string
      description?: string
      enum?: string[]
      items?: unknown
    }>
    required?: string[]
  }
}

/**
 * Extracted tool call from model output
 */
export interface ExtractedToolCall {
  id: string
  name: string
  input: Record<string, unknown>
}

/**
 * Tool call result to inject back
 */
export interface ToolCallResult {
  toolUseId: string
  content: string
  isError?: boolean
}

// Counter for generating unique tool use IDs
let toolUseIdCounter = 0

/**
 * Generate a unique tool use ID in Anthropic format
 */
export function generateToolUseId(): string {
  toolUseIdCounter++
  const timestamp = Date.now().toString(36)
  const counter = toolUseIdCounter.toString(36).padStart(4, '0')
  const random = Math.random().toString(36).substring(2, 6)
  return `toolu_${timestamp}${counter}${random}`
}

/**
 * Reset tool use ID counter (for testing)
 */
export function resetToolUseIdCounter(): void {
  toolUseIdCounter = 0
}

/**
 * Convert Anthropic tool definitions to a human-readable prompt format
 * that can be injected into the system prompt
 */
export function toolDefinitionsToPrompt(tools: ToolDefinition[]): string {
  if (!tools || tools.length === 0) return ''

  const toolDescriptions = tools.map(tool => {
    const params = tool.input_schema.properties || {}
    const required = new Set(tool.input_schema.required || [])

    const paramDescriptions = Object.entries(params)
      .map(([name, schema]) => {
        const reqMark = required.has(name) ? ' (required)' : ' (optional)'
        const typeStr = schema.type
        const desc = schema.description ? `: ${schema.description}` : ''
        const enumStr = schema.enum ? ` [options: ${schema.enum.join(', ')}]` : ''
        return `    - ${name}${reqMark}: ${typeStr}${enumStr}${desc}`
      })
      .join('\n')

    return `
<tool name="${tool.name}">
  <description>${tool.description}</description>
  <parameters>
${paramDescriptions || '    (no parameters)'}
  </parameters>
</tool>`
  }).join('\n')

  return `
<available_tools>
You have access to the following tools. When the user asks you to do something that requires using one of these tools, you MUST respond by calling the appropriate tool using this exact XML format:

<tool_call>
<name>tool_name</name>
<arguments>
{"param1": "value1", "param2": "value2"}
</arguments>
</tool_call>

Example: If the user asks "what is the weather in Tokyo?" and you have a get_weather tool, respond with:

<tool_call>
<name>get_weather</name>
<arguments>
{"location": "Tokyo"}
</arguments>
</tool_call>

DO NOT say "I don't have access to that tool" - you DO have access to these tools.
DO NOT describe what the tool would do - instead, CALL the tool directly.
DO NOT ask for confirmation - just use the tool when it's needed.

Available tools:
${toolDescriptions}

</available_tools>
`
}

/**
 * Inject tool results into the message history
 */
export function injectToolResults(
  messages: LLMMessage[],
  results: ToolCallResult[],
): LLMMessage[] {
  if (!results || results.length === 0) return messages

  // Create tool result message
  const toolResultContent: MessageContent[] = results.map(result => ({
    type: 'tool_result' as const,
    id: result.toolUseId,
    content: result.isError
      ? `Error: ${result.content}`
      : result.content,
  }))

  // Add as a user message (tool results come from user role in Anthropic format)
  return [
    ...messages,
    {
      role: 'user',
      content: toolResultContent,
    },
  ]
}

/**
 * Parse model output to extract tool calls
 * Looks for XML-formatted tool calls in the response
 */
export function parseToolCalls(text: string): ExtractedToolCall[] {
  const toolCalls: ExtractedToolCall[] = []

  // Pattern to match tool calls in XML format
  const toolCallPattern = /<tool_call>\s*<name>([^<]+)<\/name>\s*<arguments>\s*([\s\S]*?)\s*<\/arguments>\s*<\/tool_call>/gi

  let match: RegExpExecArray | null
  while ((match = toolCallPattern.exec(text)) !== null) {
    const [_, name, argsStr] = match

    try {
      // Parse JSON arguments
      const input = JSON.parse(argsStr.trim())

      toolCalls.push({
        id: generateToolUseId(),
        name: name.trim(),
        input,
      })
    } catch (error) {
      // Try to extract arguments even if JSON is malformed
      console.warn(`[toolWrapper] Failed to parse tool arguments for ${name}:`, error)

      // Attempt basic key-value extraction as fallback
      try {
        const fallbackInput = extractKeyValuePairs(argsStr)
        if (Object.keys(fallbackInput).length > 0) {
          toolCalls.push({
            id: generateToolUseId(),
            name: name.trim(),
            input: fallbackInput,
          })
        }
      } catch {
        // Skip malformed tool calls
      }
    }
  }

  // Also try to parse function-call style format used by some models
  // Match JSON in code blocks with name and arguments fields
  const jsonBlockPattern = /```(?:json)?\s*([\s\S]*?)```/gi

  while ((match = jsonBlockPattern.exec(text)) !== null) {
    const jsonContent = match[1].trim()

    try {
      const parsed = JSON.parse(jsonContent)

      // Check if it's a function call format (has name and arguments)
      if (typeof parsed.name === 'string' && parsed.arguments) {
        toolCalls.push({
          id: generateToolUseId(),
          name: parsed.name,
          input: typeof parsed.arguments === 'string'
            ? JSON.parse(parsed.arguments)
            : parsed.arguments,
        })
        continue
      }
    } catch {
      // Not valid JSON or not a tool call format, skip
    }
  }

  // Legacy pattern for inline function calls (rarely used)
  const functionCallPattern = /```(?:json)?\s*\{\s*"name"\s*:\s*"([^"]+)"[^}]*"arguments"\s*:\s*(\{[\s\S]*?\})\s*\}```/gi

  while ((match = functionCallPattern.exec(text)) !== null) {
    const [_, name, argsStr] = match

    // Skip if already captured by jsonBlockPattern
    if (toolCalls.some(tc => tc.name === name.trim())) continue

    try {
      const input = JSON.parse(argsStr)
      toolCalls.push({
        id: generateToolUseId(),
        name: name.trim(),
        input,
      })
    } catch {
      // Skip malformed calls
    }
  }

  return toolCalls
}

/**
 * Fallback extractor for malformed JSON
 */
function extractKeyValuePairs(text: string): Record<string, unknown> {
  const result: Record<string, unknown> = {}

  // Match "key": "value" or "key": value patterns
  const keyValuePattern = /"(\w+)"\s*:\s*(?:"([^"]*)"|([\d.]+|true|false|null)|\[([^\]]*)\])/g

  let match: RegExpExecArray | null
  while ((match = keyValuePattern.exec(text)) !== null) {
    const [_, key, stringValue, primitiveValue, arrayValue] = match

    if (stringValue !== undefined) {
      result[key] = stringValue
    } else if (primitiveValue !== undefined) {
      // Parse primitive values
      if (primitiveValue === 'true') result[key] = true
      else if (primitiveValue === 'false') result[key] = false
      else if (primitiveValue === 'null') result[key] = null
      else result[key] = Number(primitiveValue)
    } else if (arrayValue !== undefined) {
      try {
        result[key] = JSON.parse(`[${arrayValue}]`)
      } catch {
        result[key] = arrayValue.split(',').map(s => s.trim().replace(/^["']|["']$/g, ''))
      }
    }
  }

  return result
}

/**
 * Convert extracted tool calls to Anthropic MessageContent format
 */
export function toolCallsToMessageContent(toolCalls: ExtractedToolCall[]): MessageContent[] {
  return toolCalls.map(call => ({
    type: 'tool_use' as const,
    id: call.id,
    name: call.name,
    input: call.input,
  }))
}

/**
 * Check if the model response contains tool calls
 */
export function hasToolCalls(text: string): boolean {
  return /<tool_call>/i.test(text) ||
    /```(?:json)?\s*\{\s*"name"\s*:/i.test(text)
}

/**
 * Extract text content without tool calls
 * Returns the text before the first tool call
 */
export function extractTextBeforeToolCalls(text: string): string {
  // Find the start of the first tool call
  const toolCallStart = text.search(/<tool_call>/i)
  const functionCallStart = text.search(/```(?:json)?\s*\{\s*"name"\s*:/i)

  let cutoffIndex = text.length

  if (toolCallStart !== -1 && toolCallStart < cutoffIndex) {
    cutoffIndex = toolCallStart
  }
  if (functionCallStart !== -1 && functionCallStart < cutoffIndex) {
    cutoffIndex = functionCallStart
  }

  return text.substring(0, cutoffIndex).trim()
}

/**
 * Prepare request options for tool-enabled Ollama calls
 * Injects tool definitions into system prompt and converts tool results
 */
export function prepareToolRequest(
  options: LLMRequestOptions,
  tools?: ToolDefinition[],
): LLMRequestOptions {
  const newOptions = { ...options }

  // Inject tool definitions into system prompt
  if (tools && tools.length > 0) {
    const toolPrompt = toolDefinitionsToPrompt(tools)
    newOptions.systemPrompt = newOptions.systemPrompt
      ? `${newOptions.systemPrompt}\n\n${toolPrompt}`
      : toolPrompt
  }

  // Convert any tool_result messages to text format
  newOptions.messages = options.messages.map(msg => {
    if (Array.isArray(msg.content)) {
      const hasToolResults = msg.content.some(c => c.type === 'tool_result')
      if (hasToolResults) {
        // Convert tool results to readable text format
        const textContent = msg.content.map(c => {
          if (c.type === 'tool_result') {
            return `<tool_result tool_use_id="${c.id}">\n${c.content || c.text || ''}\n</tool_result>`
          }
          return c.text || ''
        }).join('\n')

        return {
          ...msg,
          content: textContent,
        }
      }
    }
    return msg
  })

  return newOptions
}

/**
 * Process model response to extract tool calls and format properly
 * Returns both text content and any extracted tool calls
 */
export function processToolResponse(
  responseText: string,
): { text: string; toolCalls: ExtractedToolCall[] } {
  const toolCalls = parseToolCalls(responseText)
  const text = extractTextBeforeToolCalls(responseText)

  return { text, toolCalls }
}

/**
 * Check if a model supports native tool calling
 * Most Ollama models don't, but some fine-tuned ones might
 */
export function supportsNativeToolCalling(model: string): boolean {
  // Models known to support tool calling natively
  const nativeToolModels = [
    'gpt-4',
    'gpt-3.5-turbo',
    'claude-3',
    'claude-2',
    // Some Ollama models with tool calling support
    'qwen2.5-coder', // Has function calling support
    'hermes', // Some hermes models support tools
    'functionary', // Specifically trained for function calling
  ]

  const modelLower = model.toLowerCase()
  return nativeToolModels.some(m => modelLower.includes(m))
}

/**
 * Example: Full tool calling flow
 * 
 * ```typescript
 * const tools: ToolDefinition[] = [{
 *   name: 'read_file',
 *   description: 'Read contents of a file',
 *   input_schema: {
 *     type: 'object',
 *     properties: {
 *       path: { type: 'string', description: 'File path' }
 *     },
 *     required: ['path']
 *   }
 * }]
 * 
 * // Prepare request with tools
 * const options = prepareToolRequest(originalOptions, tools)
 * 
 * // Send to Ollama and get response
 * const response = await provider.complete(options)
 * 
 * // Process response for tool calls
 * const { text, toolCalls } = processToolResponse(response.content[0].text)
 * 
 * // If tool calls found, execute them and continue
 * if (toolCalls.length > 0) {
 *   const results = await executeToolCalls(toolCalls)
 *   const nextMessages = injectToolResults(options.messages, results)
 *   // Continue conversation with tool results
 * }
 * ```
 */
