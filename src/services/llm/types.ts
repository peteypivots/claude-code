/**
 * Shared types for LLM provider abstraction
 */

export type LLMProvider = 'anthropic' | 'ollama'

export interface MessageContent {
  type: 'text' | 'tool_use' | 'tool_result'
  text?: string
  id?: string
  name?: string
  input?: unknown
  content?: string
}

export interface LLMMessage {
  role: 'user' | 'assistant'
  content: MessageContent[] | string
}

export interface LLMRequestOptions {
  model: string
  messages: LLMMessage[]
  maxTokens?: number
  systemPrompt?: string
  temperature?: number
  stopSequences?: string[]
  tools?: unknown[]
  thinking?: {
    type: 'enabled' | 'disabled'
    budgetTokens?: number
  }
}

export interface LLMResponse {
  content: MessageContent[]
  stopReason: string
  usage: {
    inputTokens: number
    outputTokens: number
  }
  model: string
}

export interface LLMStreamEvent {
  type:
    | 'content_block_start'
    | 'content_block_delta'
    | 'content_block_stop'
    | 'message_start'
    | 'message_delta'
    | 'message_stop'
  index?: number
  content_block?: {
    type: string
    text?: string
    id?: string
    name?: string
    input?: unknown
  }
  delta?: {
    type: string
    text?: string
  }
  message?: LLMResponse
}

export interface ILLMProvider {
  /**
   * Get provider name
   */
  getName(): LLMProvider

  /**
   * Check if provider is available/configured
   */
  isAvailable(): Promise<boolean>

  /**
   * Call LLM synchronously (non-streaming)
   */
  complete(options: LLMRequestOptions): Promise<LLMResponse>

  /**
   * Call LLM with streaming
   */
  stream(
    options: LLMRequestOptions,
  ): AsyncGenerator<LLMStreamEvent, void, unknown>

  /**
   * Get provider-specific error message
   */
  getErrorContext(): string
}

export class ProviderError extends Error {
  constructor(
    public provider: LLMProvider,
    message: string,
    public code?: string,
    public originalError?: Error,
  ) {
    super(`[${provider}] ${message}`)
    this.name = 'ProviderError'
  }

  isRetryable(): boolean {
    return (
      this.code === 'NETWORK_ERROR' ||
      this.code === 'TIMEOUT' ||
      this.code === 'RATE_LIMIT'
    )
  }
}
