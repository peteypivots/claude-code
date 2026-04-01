/**
 * Ollama provider implementation for local LLM inference
 * Supports native tool calling for compatible models
 */

import {
  type ILLMProvider,
  type LLMMessage,
  type LLMRequestOptions,
  type LLMResponse,
  type LLMStreamEvent,
  type MessageContent,
  ProviderError,
} from './types.js'
import { appendFileSync } from 'fs'

const ROUTER_LOG = '/tmp/router-debug.log'
function ollamaLog(msg: string) {
  const line = `[${new Date().toISOString()}] [OllamaClient] ${msg}\n`
  try { appendFileSync(ROUTER_LOG, line) } catch {}
  try { appendFileSync('/proc/1/fd/2', line) } catch {}
}

export interface OllamaConfig {
  baseUrl: string
  timeout: number
  retries: number
  model?: string  // Default model for tool calling
}

// Models known to support native tool calling
const TOOL_CAPABLE_MODELS = new Set([
  'qwen2.5:3b-instruct',
  'qwen2.5:7b-instruct', 
  'qwen2.5:14b-instruct',
  'qwen2.5:32b-instruct',
  'qwen3:8b',
  'qwen3.5:9b',
  'qwen3.5:27b',
  'llama3.2',
  'llama3.1',
  'mistral',
  'mixtral',
])

/**
 * Check if a model supports native tool calling
 */
export function supportsNativeTools(model: string): boolean {
  const normalizedModel = model.toLowerCase()
  for (const capable of TOOL_CAPABLE_MODELS) {
    if (normalizedModel.includes(capable.split(':')[0])) {
      return true
    }
  }
  return false
}

/**
 * Map Claude model names to Ollama equivalents
 * Uses env vars from .env file:
 *   - OLLAMA_MODEL: Override all mappings
 *   - LOCAL_MODEL: Default for sonnet-tier
 *   - ORCHESTRATOR_MODEL: Default for haiku-tier  
 *   - REASONING_MODEL: For reasoning tasks
 *   - OLLAMA_MODEL_OPUS/SONNET/HAIKU: Tier-specific overrides
 */
const DEFAULT_OLLAMA_MODEL = 'qwen2.5:3b-instruct'

function mapModelToOllama(model: string): string {
  const normalizedModel = model.toLowerCase()
  
  // If it's already an Ollama model (no 'claude' in name), use as-is
  if (!normalizedModel.includes('claude') && !normalizedModel.includes('anthropic')) {
    return model
  }
  
  // Global override takes precedence
  const configuredModel = process.env.OLLAMA_MODEL
  if (configuredModel) {
    return configuredModel
  }
  
  // Tier-specific mappings using .env configuration
  if (normalizedModel.includes('opus')) {
    // Opus = most capable, use largest available or REASONING_MODEL
    return process.env.OLLAMA_MODEL_OPUS || process.env.REASONING_MODEL || 'qwen3.5:27b'
  }
  if (normalizedModel.includes('sonnet')) {
    // Sonnet = balanced, use LOCAL_MODEL (worker model)
    return process.env.OLLAMA_MODEL_SONNET || process.env.LOCAL_MODEL || 'qwen2.5:14b-instruct'
  }
  if (normalizedModel.includes('haiku')) {
    // Haiku = fast/cheap, use ORCHESTRATOR_MODEL
    return process.env.OLLAMA_MODEL_HAIKU || process.env.ORCHESTRATOR_MODEL || 'qwen2.5:3b-instruct'
  }
  
  // Unknown Claude model, use LOCAL_MODEL or default
  return process.env.LOCAL_MODEL || DEFAULT_OLLAMA_MODEL
}

/**
 * Parse text-based tool calls from model output
 * Models fine-tuned on claude-code may output tool calls as:
 *   [Tool Use: ToolName]
 *   {"param": "value"}
 * 
 * @param text - Model output text
 * @param allowedToolNames - Optional set of allowed tool names. If provided, tools not in this set are skipped.
 */
function parseTextToolCalls(text: string, allowedToolNames?: Set<string>): Array<{ name: string; input: Record<string, unknown> }> {
  const toolCalls: Array<{ name: string; input: Record<string, unknown> }> = []
  
  // Match pattern 1: [Tool Use: ToolName] followed by JSON
  const toolUsePattern = /\[Tool Use:\s*([^\]]+)\]\s*(\{[\s\S]*?\})/g
  let match
  
  while ((match = toolUsePattern.exec(text)) !== null) {
    const toolName = match[1].trim()
    const argsJson = match[2]
    
    // Skip if tool is not in allowed list
    if (allowedToolNames && !allowedToolNames.has(toolName)) {
      ollamaLog(`Skipping disallowed tool call: ${toolName} (tool has been disabled)`)
      continue
    }
    
    try {
      const input = JSON.parse(argsJson)
      toolCalls.push({ name: toolName, input })
      ollamaLog(`Parsed text tool call: ${toolName} -> ${JSON.stringify(input).substring(0, 100)}`)
    } catch (e) {
      ollamaLog(`Failed to parse tool args for ${toolName}: ${argsJson.substring(0, 100)}`)
    }
  }
  
  // Match pattern 2: <tool-name>{json}</tool-name> (XML-style)
  // Map kebab-case to known tool names
  const toolNameMap: Record<string, string> = {
    'web-search': 'WebSearch',
    'web-fetch': 'WebFetch',
    'bash': 'Bash',
    'read': 'Read',
    'write': 'Write',
    'edit': 'Edit',
    'glob': 'Glob',
    'grep': 'Grep',
    'agent': 'Agent',
    'list-mcp-resources-tool': 'ListMcpResourcesTool',
    'read-mcp-resource-tool': 'ReadMcpResourceTool',
    'ask-user-question': 'AskUserQuestion',
  }
  
  const xmlToolPattern = /<([a-z][a-z0-9-]*)>\s*(\{[\s\S]*?\})\s*<\/\1>/gi
  while ((match = xmlToolPattern.exec(text)) !== null) {
    const xmlTagName = match[1].toLowerCase()
    const argsJson = match[2]
    
    // Map to actual tool name
    const toolName = toolNameMap[xmlTagName] || xmlTagName
    
    // Skip if tool is not in allowed list
    if (allowedToolNames && !allowedToolNames.has(toolName)) {
      ollamaLog(`Skipping disallowed XML tool call: ${toolName} (tool has been disabled)`)
      continue
    }
    
    try {
      const input = JSON.parse(argsJson)
      toolCalls.push({ name: toolName, input })
      ollamaLog(`Parsed XML tool call: <${xmlTagName}> -> ${toolName} -> ${JSON.stringify(input).substring(0, 100)}`)
    } catch (e) {
      ollamaLog(`Failed to parse XML tool args for <${xmlTagName}>: ${argsJson.substring(0, 100)}`)
    }
  }
  
  return toolCalls
}

/**
 * Convert Anthropic tool format to Ollama native format
 */
interface AnthropicTool {
  name: string
  description: string
  input_schema: {
    type: string
    properties: Record<string, unknown>
    required?: string[]
  }
}

interface OllamaTool {
  type: 'function'
  function: {
    name: string
    description: string
    parameters: {
      type: string
      properties: Record<string, unknown>
      required?: string[]
    }
  }
}

function convertToolsToOllamaFormat(tools: AnthropicTool[]): OllamaTool[] {
  return tools.map(tool => ({
    type: 'function',
    function: {
      name: tool.name,
      description: tool.description,
      parameters: {
        type: tool.input_schema.type,
        properties: tool.input_schema.properties,
        required: tool.input_schema.required,
      },
    },
  }))
}

const DEFAULT_OLLAMA_CONFIG: OllamaConfig = {
  baseUrl: process.env.OLLAMA_BASE_URL || 'http://localhost:11434',
  timeout: parseInt(process.env.OLLAMA_TIMEOUT || '120000', 10),
  retries: parseInt(process.env.OLLAMA_RETRIES || '3', 10),
}

export class OllamaProvider implements ILLMProvider {
  private config: OllamaConfig
  private lastError?: Error

  constructor(config: Partial<OllamaConfig> = {}) {
    this.config = { ...DEFAULT_OLLAMA_CONFIG, ...config }
  }

  getName() {
    return 'ollama' as const
  }

  async isAvailable(): Promise<boolean> {
    try {
      const controller = new AbortController()
      const timeoutId = setTimeout(() => controller.abort(), 3000)

      const response = await fetch(`${this.config.baseUrl}/api/tags`, {
        signal: controller.signal,
        timeout: 3000,
      })

      clearTimeout(timeoutId)
      this.lastError = undefined
      return response.ok
    } catch (error) {
      this.lastError = error instanceof Error ? error : new Error(String(error))
      return false
    }
  }

  async complete(options: LLMRequestOptions): Promise<LLMResponse> {
    const messages = this.convertMessages(options.messages)
    
    // Map Claude model names to Ollama equivalents
    const ollamaModel = mapModelToOllama(options.model)
    
    // Convert tools to Ollama format if provided
    const ollamaTools = options.tools ? convertToolsToOllamaFormat(options.tools as AnthropicTool[]) : undefined

    // Only override num_ctx if explicitly set - otherwise use model's Modelfile default
    const ollamaOptions: Record<string, unknown> = {
      num_gpu: 99,    // Use all GPU layers
    }
    if (process.env.OLLAMA_NUM_CTX) {
      ollamaOptions.num_ctx = parseInt(process.env.OLLAMA_NUM_CTX, 10)
    }

    const requestBody: Record<string, unknown> = {
      model: ollamaModel,
      messages,
      system: options.systemPrompt,
      stream: false,
      options: ollamaOptions,
      ...(options.temperature !== undefined && {
        temperature: options.temperature,
      }),
      ...(options.maxTokens !== undefined && {
        num_predict: options.maxTokens,
      }),
    }
    
    // Add tools if provided and model supports them
    if (ollamaTools && ollamaTools.length > 0) {
      requestBody.tools = ollamaTools
    }

    let lastError: Error | undefined
    for (let attempt = 0; attempt <= this.config.retries; attempt++) {
      try {
        const controller = new AbortController()
        const timeoutId = setTimeout(
          () => controller.abort(),
          this.config.timeout,
        )

        const response = await fetch(`${this.config.baseUrl}/api/chat`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(requestBody),
          signal: controller.signal,
          timeout: this.config.timeout,
        })

        clearTimeout(timeoutId)

        if (!response.ok) {
          const errorText = await response.text()
          throw new Error(
            `HTTP ${response.status}: ${errorText.substring(0, 200)}`,
          )
        }

        const data = await response.json()
        
        // Build content array
        const content: MessageContent[] = []
        
        // Add text content if present
        if (data.message?.content) {
          content.push({ type: 'text', text: data.message.content })
        }
        
        // Add tool calls if present (native Ollama tool calling)
        if (data.message?.tool_calls && Array.isArray(data.message.tool_calls)) {
          for (const toolCall of data.message.tool_calls) {
            content.push({
              type: 'tool_use',
              id: toolCall.id || `toolu_${Date.now().toString(36)}${Math.random().toString(36).substring(2, 6)}`,
              name: toolCall.function?.name || toolCall.name,
              input: toolCall.function?.arguments || toolCall.arguments || {},
            })
          }
        }
        
        // Ensure at least empty text if no content
        if (content.length === 0) {
          content.push({ type: 'text', text: '' })
        }
        
        // Determine stop reason
        const hasToolCalls = content.some(c => c.type === 'tool_use')
        const stopReason = hasToolCalls ? 'tool_use' : (data.done ? 'end_turn' : 'max_tokens')

        return {
          content,
          stopReason,
          usage: {
            inputTokens: data.prompt_eval_count || 0,
            outputTokens: data.eval_count || 0,
          },
          model: options.model,
        }
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error))

        const isRetryable =
          error instanceof TypeError ||
          (error instanceof Error &&
            (error.message.includes('timeout') ||
              error.message.includes('ECONNREFUSED') ||
              error.message.includes('ECONNRESET')))

        if (!isRetryable || attempt === this.config.retries) {
          throw new ProviderError(
            'ollama',
            `Failed to get completion: ${lastError.message}`,
            isRetryable ? 'NETWORK_ERROR' : 'UNKNOWN',
            lastError,
          )
        }

        // Exponential backoff
        await new Promise((resolve) =>
          setTimeout(resolve, Math.pow(2, attempt) * 500),
        )
      }
    }

    throw new ProviderError(
      'ollama',
      `Failed after ${this.config.retries} retries`,
      'RETRY_EXHAUSTED',
      lastError,
    )
  }

  async *stream(
    options: LLMRequestOptions,
  ): AsyncGenerator<LLMStreamEvent, void, unknown> {
    const messages = this.convertMessages(options.messages)
    
    // DEBUG: Log converted messages - especially tool results
    if (process.env.OLLAMA_DEBUG) {
      console.log(`[OllamaClient] Sending ${messages.length} messages to model`)
      for (const m of messages) {
        if (m.role === 'tool') {
          console.log(`[OllamaClient]   TOOL msg: tool_call_id=${(m as any).tool_call_id}, content=${String((m as any).content).substring(0, 100)}...`)
        } else {
          const contentPreview = typeof m.content === 'string' ? m.content.substring(0, 80) : JSON.stringify(m.content).substring(0, 80)
          console.log(`[OllamaClient]   ${m.role}: ${contentPreview}...`)
        }
      }
    }
    
    // Map Claude model names to Ollama equivalents
    const ollamaModel = mapModelToOllama(options.model)
    
    // Convert tools to Ollama format if provided
    const ollamaTools = options.tools ? convertToolsToOllamaFormat(options.tools as AnthropicTool[]) : undefined
    
    // Build set of allowed tool names for text-based tool parsing
    const allowedToolNames = ollamaTools 
      ? new Set(ollamaTools.map(t => t.function.name))
      : undefined

    // Only override num_ctx if explicitly set - otherwise use model's Modelfile default
    const streamOptions: Record<string, unknown> = {
      num_gpu: 99,    // Use all GPU layers
    }
    if (process.env.OLLAMA_NUM_CTX) {
      streamOptions.num_ctx = parseInt(process.env.OLLAMA_NUM_CTX, 10)
    }

    const requestBody: Record<string, unknown> = {
      model: ollamaModel,
      messages,
      system: options.systemPrompt,
      stream: true,
      options: streamOptions,
      ...(options.temperature !== undefined && {
        temperature: options.temperature,
      }),
      ...(options.maxTokens !== undefined && {
        num_predict: options.maxTokens,
      }),
    }
    
    // Add tools if provided
    if (ollamaTools && ollamaTools.length > 0) {
      requestBody.tools = ollamaTools
      ollamaLog(`stream() sending ${ollamaTools.length} tools to model ${ollamaModel}`)
      ollamaLog(`First tool: ${JSON.stringify(ollamaTools[0]).substring(0, 300)}`)
    } else {
      ollamaLog(`stream() NO tools sent to model ${ollamaModel}`)
    }

    let lastError: Error | undefined

    for (let attempt = 0; attempt <= this.config.retries; attempt++) {
      try {
        const controller = new AbortController()
        const timeoutId = setTimeout(
          () => controller.abort(),
          this.config.timeout,
        )

        const response = await fetch(`${this.config.baseUrl}/api/chat`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(requestBody),
          signal: controller.signal,
          timeout: this.config.timeout,
        })

        clearTimeout(timeoutId)

        if (!response.ok) {
          const errorText = await response.text()
          throw new Error(
            `HTTP ${response.status}: ${errorText.substring(0, 200)}`,
          )
        }

        if (!response.body) {
          throw new Error('Response body is empty')
        }

        const reader = response.body.getReader()
        const decoder = new TextDecoder()
        let buffer = ''
        
        // Accumulate tool calls from streaming chunks (they only appear in non-done chunks)
        const accumulatedToolCalls: Array<{ id: string; name: string; input: Record<string, unknown> }> = []
        // Accumulate text content for text-based tool parsing
        let accumulatedText = ''

        try {
          while (true) {
            const { done, value } = await reader.read()
            if (done) break

            buffer += decoder.decode(value, { stream: true })
            const lines = buffer.split('\n')

            // Keep last incomplete line in buffer
            buffer = lines.pop() || ''

            for (const line of lines) {
              if (!line.trim()) continue

              try {
                const chunk = JSON.parse(line)
                
                // Debug: log raw Ollama chunks
                if (process.env.OLLAMA_DEBUG === 'true') {
                  ollamaLog(`Raw chunk: ${JSON.stringify(chunk).substring(0, 500)}`)
                }

                if (chunk.message?.content) {
                  accumulatedText += chunk.message.content
                  yield {
                    type: 'content_block_delta',
                    delta: {
                      type: 'text_delta',
                      text: chunk.message.content,
                    },
                  }
                }
                
                // Handle tool calls in streaming response - accumulate them
                if (chunk.message?.tool_calls && Array.isArray(chunk.message.tool_calls)) {
                  for (const toolCall of chunk.message.tool_calls) {
                    const toolId = toolCall.id || `toolu_${Date.now().toString(36)}${Math.random().toString(36).substring(2, 6)}`
                    const toolName = toolCall.function?.name || toolCall.name
                    const toolInput = toolCall.function?.arguments || toolCall.arguments || {}
                    
                    // Accumulate for final message
                    accumulatedToolCalls.push({ id: toolId, name: toolName, input: toolInput })
                    
                    yield {
                      type: 'content_block_start',
                      content_block: {
                        type: 'tool_use',
                        id: toolId,
                        name: toolName,
                        input: toolInput,
                      },
                    }
                  }
                }

                if (chunk.done) {
                  // Build final content array using accumulated tool calls
                  const finalContent: MessageContent[] = []
                  let blockedToolCall: string | null = null
                  
                  // Check for text-based tool calls if no native tool_calls were found
                  if (accumulatedToolCalls.length === 0 && accumulatedText) {
                    // First check if there are any tool calls that would be blocked
                    const allTextToolCalls = parseTextToolCalls(accumulatedText, undefined) // Get all parsed calls
                    const filteredToolCalls = parseTextToolCalls(accumulatedText, allowedToolNames) // Get only allowed
                    
                    // If some were blocked, record which one
                    if (allTextToolCalls.length > 0 && filteredToolCalls.length === 0) {
                      blockedToolCall = allTextToolCalls[0]?.name || null
                    }
                    
                    for (const tc of filteredToolCalls) {
                      const toolId = `toolu_${Date.now().toString(36)}${Math.random().toString(36).substring(2, 6)}`
                      accumulatedToolCalls.push({ id: toolId, name: tc.name, input: tc.input })
                    }
                  }
                  
                  // Only include text content if no tool calls (tool-using text is for the LLM, not user)
                  if (accumulatedToolCalls.length === 0 && chunk.message?.content) {
                    finalContent.push({ type: 'text', text: chunk.message.content })
                  }
                  
                  // If a tool was blocked and there's no other content, provide helpful message
                  if (blockedToolCall && finalContent.length === 0 && accumulatedToolCalls.length === 0) {
                    finalContent.push({ 
                      type: 'text', 
                      text: `I attempted to use ${blockedToolCall} again, but it has been disabled due to a loop. I should now answer the user's question based on the information I've already gathered from previous tool results. If I need more information, I should try a different tool.`
                    })
                    ollamaLog(`Injected fallback text for blocked tool: ${blockedToolCall}`)
                  }
                  
                  // Use accumulated tool calls (from native or text-parsed)
                  for (const tc of accumulatedToolCalls) {
                    finalContent.push({
                      type: 'tool_use',
                      id: tc.id,
                      name: tc.name,
                      input: tc.input,
                    })
                  }
                  
                  const hasToolCalls = accumulatedToolCalls.length > 0
                  
                  yield {
                    type: 'message_stop',
                    message: {
                      content: finalContent.length > 0 ? finalContent : [{ type: 'text', text: '' }],
                      stopReason: hasToolCalls ? 'tool_use' : 'end_turn',
                      usage: {
                        inputTokens: chunk.prompt_eval_count || 0,
                        outputTokens: chunk.eval_count || 0,
                      },
                      model: options.model,
                    },
                  }
                }
              } catch {
                // Skip malformed lines
              }
            }
          }

          // Final buffer
          if (buffer.trim()) {
            try {
              const chunk = JSON.parse(buffer)
              if (chunk.message?.content) {
                yield {
                  type: 'content_block_delta',
                  delta: {
                    type: 'text_delta',
                    text: chunk.message.content,
                  },
                }
              }
            } catch {
              // Skip malformed final line
            }
          }

          return
        } finally {
          reader.releaseLock()
        }
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error))

        const isRetryable =
          error instanceof TypeError ||
          (error instanceof Error &&
            (error.message.includes('timeout') ||
              error.message.includes('ECONNREFUSED') ||
              error.message.includes('ECONNRESET')))

        if (!isRetryable || attempt === this.config.retries) {
          throw new ProviderError(
            'ollama',
            `Stream failed: ${lastError.message}`,
            isRetryable ? 'NETWORK_ERROR' : 'UNKNOWN',
            lastError,
          )
        }

        // Exponential backoff
        await new Promise((resolve) =>
          setTimeout(resolve, Math.pow(2, attempt) * 500),
        )
      }
    }

    throw new ProviderError(
      'ollama',
      `Stream failed after ${this.config.retries} retries`,
      'RETRY_EXHAUSTED',
      lastError,
    )
  }

  getErrorContext(): string {
    if (this.lastError) {
      return `Ollama error: ${this.lastError.message}`
    }
    return `Ollama not available at ${this.config.baseUrl}`
  }

  private convertMessages(messages: LLMMessage[]) {
    return messages.map((msg) => {
      // Handle tool results - convert to Ollama format
      if (Array.isArray(msg.content)) {
        const hasToolResult = msg.content.some(c => c.type === 'tool_result')
        if (hasToolResult) {
          // For tool results, return in Ollama's expected format
          const toolResults = msg.content
            .filter(c => c.type === 'tool_result')
            .map(c => ({
              tool_call_id: (c as { id?: string }).id,
              content: (c as { content?: string }).content || '',
            }))
          
          return {
            role: 'tool',
            content: toolResults[0]?.content || '',
            tool_call_id: toolResults[0]?.tool_call_id,
          }
        }
        
        // Convert other content types to string
        return {
          role: msg.role,
          content: msg.content
            .map((c) => {
              if (c.type === 'text') {
                return c.text || ''
              } else if (c.type === 'tool_use') {
                return `[Tool Use: ${c.name}]\n${JSON.stringify(c.input)}`
              }
              return ''
            })
            .join('\n'),
        }
      }
      
      return {
        role: msg.role,
        content: msg.content,
      }
    })
  }
}
