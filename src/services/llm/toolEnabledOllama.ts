/**
 * Tool-Enabled Ollama Provider
 * 
 * Wraps the base OllamaProvider with tool calling support.
 * Automatically injects tool definitions, parses responses,
 * and converts between Anthropic and Ollama formats.
 */

import type {
  ILLMProvider,
  LLMRequestOptions,
  LLMResponse,
  LLMStreamEvent,
  MessageContent,
} from './types.js'
import { OllamaProvider, type OllamaConfig } from './ollamaClient.js'
import {
  type ToolDefinition,
  type ExtractedToolCall,
  prepareToolRequest,
  processToolResponse,
  parseToolCalls,
  hasToolCalls,
  generateToolUseId,
  toolCallsToMessageContent,
  supportsNativeToolCalling,
} from './toolWrapper.js'

/**
 * Configuration for tool-enabled Ollama
 */
export interface ToolEnabledOllamaConfig extends Partial<OllamaConfig> {
  /** Whether to enable tool calling support */
  enableToolCalling?: boolean
  /** Override tool definitions (if not provided in request) */
  defaultTools?: ToolDefinition[]
}

/**
 * Tool-enabled wrapper around OllamaProvider
 */
export class ToolEnabledOllamaProvider implements ILLMProvider {
  private baseProvider: OllamaProvider
  private config: ToolEnabledOllamaConfig

  constructor(config: ToolEnabledOllamaConfig = {}) {
    this.config = {
      enableToolCalling: true,
      ...config,
    }
    this.baseProvider = new OllamaProvider(config)
  }

  getName() {
    return 'ollama' as const
  }

  async isAvailable(): Promise<boolean> {
    return this.baseProvider.isAvailable()
  }

  getErrorContext(): string {
    return this.baseProvider.getErrorContext()
  }

  /**
   * Complete with tool calling support
   */
  async complete(options: LLMRequestOptions): Promise<LLMResponse> {
    // Check if tools are provided and tool calling is enabled
    const tools = options.tools as ToolDefinition[] | undefined
    const shouldUseToolWrapper =
      this.config.enableToolCalling &&
      tools &&
      tools.length > 0 &&
      !supportsNativeToolCalling(options.model)

    if (!shouldUseToolWrapper) {
      // Pass through to base provider
      return this.baseProvider.complete(options)
    }

    // Prepare request with tool definitions in prompt
    const preparedOptions = prepareToolRequest(options, tools)

    // Get response from base provider
    const response = await this.baseProvider.complete(preparedOptions)

    // Process response for tool calls
    const responseText = response.content
      .filter(c => c.type === 'text')
      .map(c => c.text || '')
      .join('')

    const { text, toolCalls } = processToolResponse(responseText)

    // Build response content
    const content: MessageContent[] = []

    // Add text content if present
    if (text) {
      content.push({ type: 'text', text })
    }

    // Add tool calls if found
    if (toolCalls.length > 0) {
      content.push(...toolCallsToMessageContent(toolCalls))
    }

    // If no content, keep original
    if (content.length === 0) {
      return response
    }

    return {
      ...response,
      content,
      stopReason: toolCalls.length > 0 ? 'tool_use' : response.stopReason,
    }
  }

  /**
   * Stream with tool calling support
   * 
   * Note: Tool calls are detected after accumulating the full response,
   * so they appear at the end of the stream.
   */
  async *stream(
    options: LLMRequestOptions,
  ): AsyncGenerator<LLMStreamEvent, void, unknown> {
    // Check if tools are provided and tool calling is enabled
    const tools = options.tools as ToolDefinition[] | undefined
    const shouldUseToolWrapper =
      this.config.enableToolCalling &&
      tools &&
      tools.length > 0 &&
      !supportsNativeToolCalling(options.model)

    if (!shouldUseToolWrapper) {
      // Pass through to base provider
      yield* this.baseProvider.stream(options)
      return
    }

    // Prepare request with tool definitions in prompt
    const preparedOptions = prepareToolRequest(options, tools)

    // Accumulate response to detect tool calls
    let accumulatedText = ''
    let inputTokens = 0
    let outputTokens = 0

    // Stream from base provider
    const baseStream = this.baseProvider.stream(preparedOptions)

    for await (const event of baseStream) {
      // Track tokens
      if (event.type === 'message_stop' && event.message) {
        inputTokens = event.message.usage?.inputTokens || 0
        outputTokens = event.message.usage?.outputTokens || 0
      }

      // Accumulate text content
      if (event.type === 'content_block_delta' && event.delta?.text) {
        accumulatedText += event.delta.text
        
        // Yield the delta event
        yield event
      } else {
        // Pass through non-content events
        yield event
      }
    }

    // After streaming completes, check for tool calls
    if (hasToolCalls(accumulatedText)) {
      const toolCalls = parseToolCalls(accumulatedText)

      if (toolCalls.length > 0) {
        // Emit tool use events for each tool call
        for (let i = 0; i < toolCalls.length; i++) {
          const call = toolCalls[i]

          // Emit content_block_start for tool_use
          yield {
            type: 'content_block_start',
            index: i + 1, // After text block
            content_block: {
              type: 'tool_use',
              id: call.id,
              name: call.name,
            },
          }

          // Emit content_block_delta with input
          yield {
            type: 'content_block_delta',
            index: i + 1,
            delta: {
              type: 'input_json_delta',
              partial_json: JSON.stringify(call.input),
            },
          } as any

          // Emit content_block_stop
          yield {
            type: 'content_block_stop',
            index: i + 1,
          }
        }

        // Emit final message_stop with tool_use stop reason
        yield {
          type: 'message_stop',
          message: {
            content: [
              { type: 'text', text: accumulatedText },
              ...toolCallsToMessageContent(toolCalls),
            ],
            stopReason: 'tool_use',
            usage: { inputTokens, outputTokens },
            model: options.model,
          },
        }
      }
    }
  }
}

/**
 * Create a tool-enabled Ollama provider instance
 */
export function createToolEnabledOllamaProvider(
  config?: ToolEnabledOllamaConfig,
): ToolEnabledOllamaProvider {
  return new ToolEnabledOllamaProvider(config)
}

/**
 * Example usage with tools:
 * 
 * ```typescript
 * const provider = createToolEnabledOllamaProvider({
 *   baseUrl: 'http://localhost:11434',
 *   enableToolCalling: true,
 * })
 * 
 * const response = await provider.complete({
 *   model: 'qwen2.5:7b',
 *   messages: [{ role: 'user', content: 'Read the file config.json' }],
 *   tools: [{
 *     name: 'read_file',
 *     description: 'Read a file from disk',
 *     input_schema: {
 *       type: 'object',
 *       properties: {
 *         path: { type: 'string', description: 'File path' }
 *       },
 *       required: ['path']
 *     }
 *   }],
 * })
 * 
 * // Response will contain tool_use content if model called a tool
 * const toolCalls = response.content.filter(c => c.type === 'tool_use')
 * ```
 */
