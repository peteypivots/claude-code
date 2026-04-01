/**
 * Anthropic provider implementation using existing Claude Code infrastructure
 * Acts as adapter to the existing Anthropic SDK integration
 */

import type Anthropic from '@anthropic-ai/sdk'
import {
  type ILLMProvider,
  type LLMMessage,
  type LLMRequestOptions,
  type LLMResponse,
  type LLMStreamEvent,
  ProviderError,
} from './types.js'
import { getAnthropicClient } from '../api/client.js'

export interface AnthropicProviderConfig {
  apiKey?: string
  maxRetries?: number
  customClient?: Anthropic
}

export class AnthropicProvider implements ILLMProvider {
  private client?: Anthropic
  private apiKey?: string
  private maxRetries: number
  private lastError?: Error

  constructor(config: AnthropicProviderConfig = {}) {
    this.apiKey = config.apiKey || process.env.ANTHROPIC_API_KEY
    this.client = config.customClient
    this.maxRetries = config.maxRetries ?? 10
  }

  getName() {
    return 'anthropic' as const
  }

  async isAvailable(): Promise<boolean> {
    try {
      if (!this.apiKey && !this.client) {
        this.lastError = new Error('ANTHROPIC_API_KEY not set')
        return false
      }

      // Ensure client is initialized
      if (!this.client) {
        this.client = await getAnthropicClient({
          apiKey: this.apiKey,
          maxRetries: 0,
        })
      }

      // Quick health check
      this.lastError = undefined
      return true
    } catch (error) {
      this.lastError = error instanceof Error ? error : new Error(String(error))
      return false
    }
  }

  async complete(options: LLMRequestOptions): Promise<LLMResponse> {
    const client = await this.ensureClient()

    const messages = this.convertMessages(options.messages)

    try {
      const response = await client.messages.create({
        model: options.model,
        max_tokens: options.maxTokens || 4096,
        system: options.systemPrompt,
        messages,
        temperature: options.temperature,
      })

      const content = response.content.map((block) => {
        if (block.type === 'text') {
          return { type: 'text' as const, text: block.text }
        } else if (block.type === 'tool_use') {
          return {
            type: 'tool_use' as const,
            id: block.id,
            name: block.name,
            input: block.input,
          }
        }
        return { type: 'text' as const, text: '' }
      })

      return {
        content,
        stopReason: response.stop_reason,
        usage: {
          inputTokens: response.usage.input_tokens,
          outputTokens: response.usage.output_tokens,
        },
        model: response.model,
      }
    } catch (error) {
      throw new ProviderError(
        'anthropic',
        `Failed to get completion: ${(error as Error).message}`,
        'UNKNOWN',
        error instanceof Error ? error : new Error(String(error)),
      )
    }
  }

  async *stream(
    options: LLMRequestOptions,
  ): AsyncGenerator<LLMStreamEvent, void, unknown> {
    const client = await this.ensureClient()

    const messages = this.convertMessages(options.messages)

    try {
      const stream = await client.messages.create({
        model: options.model,
        max_tokens: options.maxTokens || 4096,
        system: options.systemPrompt,
        messages,
        temperature: options.temperature,
        stream: true,
      })

      for await (const event of stream) {
        yield this.convertStreamEvent(event)
      }
    } catch (error) {
      throw new ProviderError(
        'anthropic',
        `Stream failed: ${(error as Error).message}`,
        'UNKNOWN',
        error instanceof Error ? error : new Error(String(error)),
      )
    }
  }

  getErrorContext(): string {
    if (this.lastError) {
      return `Anthropic error: ${this.lastError.message}`
    }
    if (!this.apiKey && !this.client) {
      return 'Anthropic API key not configured (ANTHROPIC_API_KEY env var)'
    }
    return 'Anthropic provider ready'
  }

  private async ensureClient(): Promise<Anthropic> {
    if (!this.client) {
      this.client = await getAnthropicClient({
        apiKey: this.apiKey,
        maxRetries: this.maxRetries,
      })
    }
    return this.client
  }

  private convertMessages(
    messages: LLMMessage[],
  ): Anthropic.MessageParam[] {
    return messages.map((msg) => ({
      role: msg.role,
      content: Array.isArray(msg.content)
        ? msg.content.map((c) => {
            if (c.type === 'text') {
              return { type: 'text' as const, text: c.text || '' }
            } else if (c.type === 'tool_use') {
              return {
                type: 'tool_use' as const,
                id: c.id || '',
                name: c.name || '',
                input: c.input,
              }
            } else if (c.type === 'tool_result') {
              return {
                type: 'tool_result' as const,
                tool_use_id: c.id || '',
                content: c.content || '',
              }
            }
            return { type: 'text' as const, text: '' }
          })
        : [{ type: 'text' as const, text: msg.content }],
    }))
  }

  private convertStreamEvent(event: unknown): LLMStreamEvent {
    const e = event as Record<string, unknown>
    const type = e.type as string

    // Map Anthropic stream events to our generic format
    if (type === 'content_block_start') {
      return {
        type: 'content_block_start',
        index: e.index as number,
        content_block: e.content_block as Record<string, unknown>,
      }
    } else if (type === 'content_block_delta') {
      return {
        type: 'content_block_delta',
        index: e.index as number,
        delta: e.delta as Record<string, unknown>,
      }
    } else if (type === 'content_block_stop') {
      return {
        type: 'content_block_stop',
        index: e.index as number,
      }
    }

    // Default passthrough
    return { type } as LLMStreamEvent
  }
}
