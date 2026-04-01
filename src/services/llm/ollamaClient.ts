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
    
    // Convert tools to Ollama format if provided
    const ollamaTools = options.tools ? convertToolsToOllamaFormat(options.tools as AnthropicTool[]) : undefined

    const requestBody: Record<string, unknown> = {
      model: options.model,
      messages,
      system: options.systemPrompt,
      stream: false,
      options: {
        num_ctx: 8192,  // Reduced from 32K to fit in GPU VRAM
        num_gpu: 99,    // Use all GPU layers
      },
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
    
    // Convert tools to Ollama format if provided
    const ollamaTools = options.tools ? convertToolsToOllamaFormat(options.tools as AnthropicTool[]) : undefined

    const requestBody: Record<string, unknown> = {
      model: options.model,
      messages,
      system: options.systemPrompt,
      stream: true,
      options: {
        num_ctx: 8192,  // Reduced from 32K to fit in GPU VRAM
        num_gpu: 99,    // Use all GPU layers
      },
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

                if (chunk.message?.content) {
                  yield {
                    type: 'content_block_delta',
                    delta: {
                      type: 'text_delta',
                      text: chunk.message.content,
                    },
                  }
                }
                
                // Handle tool calls in streaming response
                if (chunk.message?.tool_calls && Array.isArray(chunk.message.tool_calls)) {
                  for (const toolCall of chunk.message.tool_calls) {
                    yield {
                      type: 'content_block_start',
                      content_block: {
                        type: 'tool_use',
                        id: toolCall.id || `toolu_${Date.now().toString(36)}${Math.random().toString(36).substring(2, 6)}`,
                        name: toolCall.function?.name || toolCall.name,
                        input: toolCall.function?.arguments || toolCall.arguments || {},
                      },
                    }
                  }
                }

                if (chunk.done) {
                  // Build final content array
                  const finalContent: MessageContent[] = []
                  
                  if (chunk.message?.content) {
                    finalContent.push({ type: 'text', text: chunk.message.content })
                  }
                  
                  if (chunk.message?.tool_calls) {
                    for (const toolCall of chunk.message.tool_calls) {
                      finalContent.push({
                        type: 'tool_use',
                        id: toolCall.id || `toolu_${Date.now().toString(36)}${Math.random().toString(36).substring(2, 6)}`,
                        name: toolCall.function?.name || toolCall.name,
                        input: toolCall.function?.arguments || toolCall.arguments || {},
                      })
                    }
                  }
                  
                  const hasToolCalls = finalContent.some(c => c.type === 'tool_use')
                  
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
