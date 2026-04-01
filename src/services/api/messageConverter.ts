/**
 * Message converter: Bridge between Claude Code's Anthropic SDK format
 * and the LLMRouter provider abstraction
 */

import type {
  BetaMessageStreamParams,
  BetaMessage,
  BetaContentBlock,
  BetaRawMessageStreamEvent,
} from '@anthropic-ai/sdk/resources/beta/messages/messages.mjs'
import type {
  LLMMessage,
  LLMRequestOptions,
  LLMResponse,
  LLMStreamEvent,
} from '../llm/types.js'
import type { Message, StreamEvent } from '../../types/message.js'

/**
 * Convert Claude Code message format to LLM provider format
 */
export function convertClaudeCodeMessageToLLM(
  message: Message,
): LLMMessage | undefined {
  if (message.role === 'user') {
    // Convert user message content blocks
    const content = Array.isArray(message.content)
      ? message.content
          .map((block: any) => {
            if (block.type === 'text') {
              return { type: 'text' as const, text: block.text }
            } else if (block.type === 'image') {
              // Skip images for now - Ollama doesn't support them yet
              return undefined
            } else if (block.type === 'tool_result') {
              return {
                type: 'tool_result' as const,
                id: block.tool_use_id,
                name: block.name,
                content: block.content,
              }
            }
            return undefined
          })
          .filter(Boolean) as LLMMessage['content'][]
      : [{ type: 'text' as const, text: message.text }]

    return {
      role: 'user' as const,
      content,
    }
  } else if (message.role === 'assistant') {
    // Convert assistant message content blocks
    const content = message.content
      .map((block: any) => {
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
        return undefined
      })
      .filter(Boolean) as LLMMessage['content'][]

    return {
      role: 'assistant' as const,
      content,
    }
  }

  return undefined
}

/**
 * Convert Claude Code messages to LLM provider format
 */
export function convertClaudeCodeMessagesToLLM(
  messages: Message[],
): LLMMessage[] {
  return messages
    .map(convertClaudeCodeMessageToLLM)
    .filter((m): m is LLMMessage => m !== undefined)
}

/**
 * Convert request parameters from Claude Code format to LLM provider format
 */
export function convertBetaParamsToLLMOptions(
  params: BetaMessageStreamParams,
  systemPrompt?: string,
  model?: string,
): LLMRequestOptions {
  return {
    model: model || params.model || 'claude-3-5-sonnet',
    messages: params.messages.map(msg => ({
      role: msg.role as 'user' | 'assistant',
      content:
        typeof msg.content === 'string'
          ? msg.content
          : msg.content
              .map(block => {
                if ('text' in block) {
                  return {
                    type: 'text' as const,
                    text: block.text,
                  }
                } else if ('tool_use_id' in block) {
                  return {
                    type: 'tool_result' as const,
                    id: block.tool_use_id,
                    name: 'name' in block ? block.name : undefined,
                    content: 'content' in block ? block.content : undefined,
                  }
                } else if ('id' in block) {
                  return {
                    type: 'tool_use' as const,
                    id: block.id,
                    name: 'name' in block ? block.name : 'unknown',
                    input: 'input' in block ? block.input : {},
                  }
                }
                return { type: 'text' as const, text: '' }
              })
              .filter(Boolean),
    })),
    systemPrompt,
    maxTokens: params.max_tokens || 4096,
    temperature: params.temperature || 1,
    ...(params.thinking &&
      params.thinking.type !== 'disabled' && {
        thinking: {
          type: 'enabled' as const,
          budgetTokens:
            params.thinking.type === 'budget_tokens'
              ? params.thinking.budget_tokens
              : undefined,
        },
      }),
  }
}

/**
 * Convert LLM provider response to Anthropic SDK message format
 */
export function convertLLMResponseToBetaMessage(
  response: LLMResponse,
): BetaMessage {
  return {
    id: 'msg_' + Math.random().toString(36).substring(7),
    type: 'message',
    role: 'assistant',
    content: (response.content as BetaContentBlock[]).map(block => {
      if (block.type === 'text') {
        return {
          type: 'text',
          text: block.text || '',
        }
      } else if (block.type === 'tool_use') {
        return {
          type: 'tool_use',
          id: block.id || '',
          name: block.name || '',
          input: block.input || {},
        }
      }
      return { type: 'text' as const, text: '' }
    }),
    model: response.model,
    stop_reason: response.stopReason as any,
    stop_sequence: null,
    usage: {
      input_tokens: response.usage.inputTokens,
      output_tokens: response.usage.outputTokens,
    },
  } as BetaMessage
}

/**
 * Convert LLM provider stream event to Anthropic SDK stream event format
 * This allows Ollama responses to be processed through the same stream handling logic
 */
export function convertLLMStreamEventToAnthropicEvent(
  event: LLMStreamEvent,
  accumulatedText: string = '',
): BetaRawMessageStreamEvent {
  if (event.type === 'content_block_start') {
    return {
      type: 'content_block_start',
      index: event.index || 0,
      content_block: event.content_block as any,
    }
  } else if (event.type === 'content_block_delta') {
    return {
      type: 'content_block_delta',
      index: event.index || 0,
      delta: {
        type: 'text_delta',
        text: event.delta?.text || '',
      },
    } as BetaRawMessageStreamEvent
  } else if (event.type === 'content_block_stop') {
    return {
      type: 'content_block_stop',
      index: event.index || 0,
    }
  } else if (event.type === 'message_stop') {
    return {
      type: 'message_stop',
    } as BetaRawMessageStreamEvent
  }

  // Default passthrough for unknown event types
  return event as unknown as BetaRawMessageStreamEvent
}
