/**
 * Stream Adapter
 * Converts provider-agnostic LLM streams to Anthropic SDK format
 * 
 * Purpose:
 * - Wrap any ILLMProvider stream generator
 * - Convert LLMStreamEvent → BetaRawMessageStreamEvent
 * - Accumulate message content and metadata
 * - Maintain compatibility with existing Anthropic SDK consumers
 */

import type {
  BetaRawMessageStreamEvent,
  BetaRawContentBlockDeltaEvent,
  BetaRawContentBlockStartEvent,
  BetaRawContentBlockStopEvent,
  BetaRawMessageStartEvent,
  BetaRawMessageDeltaEvent,
  BetaRawMessageStopEvent,
} from '@anthropic-ai/sdk/resources/beta/messages'

import type {
  LLMStreamEvent,
  LLMMessage,
  LLMResponse,
} from './types'

/**
 * Converts an LLMProvider stream to Anthropic SDK event format
 * 
 * Usage:
 * ```typescript
 * const llmStream = provider.stream(options);
 * const anthropicStream = createStreamAdapter(llmStream);
 * for await (const event of anthropicStream) {
 *   // events are BetaRawMessageStreamEvent
 * }
 * ```
 */
export async function* createStreamAdapter(
  llmStream: AsyncGenerator<LLMStreamEvent, void, unknown>,
  requestId: string = generateMessageId(),
): AsyncGenerator<BetaRawMessageStreamEvent, void, unknown> {
  let contentBlocks: Array<{ type: 'text'; text: string }> = []
  let currentContent = ''
  let inputTokens = 0
  let outputTokens = 0
  let finishReason: 'end_turn' | 'max_tokens' | 'stop_sequence' | 'tool_use' | null = null

  try {
    // Emit message start event
    yield {
      type: 'message_start',
      message: {
        id: requestId,
        type: 'message',
        role: 'assistant',
        content: [],
        model: 'unknown',
        stop_reason: null,
        stop_sequence: null,
        usage: {
          input_tokens: 0,
          output_tokens: 0,
          cache_creation_input_tokens: 0,
          cache_read_input_tokens: 0,
        } as any,
      },
    } as BetaRawMessageStartEvent

    let blockIndex = 0
    let blockStarted = false  // Track if we've emitted content_block_start

    // Stream events from provider
    for await (const event of llmStream) {
      if (event.type === 'message_start') {
        // Update model info - note: LLMStreamEvent structure varies
        inputTokens = 0
      } else if (event.type === 'content_block_start') {
        // Emit content block start
        const contentBlock = { type: 'text' as const, text: '' }
        contentBlocks.push(contentBlock)

        yield {
          type: 'content_block_start',
          index: blockIndex,
          content_block: contentBlock as any,
        } as BetaRawContentBlockStartEvent

        blockStarted = true
        blockIndex++
      } else if (event.type === 'content_block_delta') {
        // Auto-emit content_block_start if not yet emitted
        if (!blockStarted) {
          const contentBlock = { type: 'text' as const, text: '' }
          contentBlocks.push(contentBlock)

          yield {
            type: 'content_block_start',
            index: blockIndex,
            content_block: contentBlock as any,
          } as BetaRawContentBlockStartEvent

          blockStarted = true
          blockIndex++
        }

        // Accumulate content and emit delta
        // Note: event structure depends on provider implementation
        const textContent = event.delta?.text || (event as any)?.text || ''
        if (textContent) {
          currentContent += textContent

          // Update last content block
          if (contentBlocks.length > 0) {
            const lastBlock = contentBlocks[contentBlocks.length - 1]
            if (lastBlock.type === 'text') {
              lastBlock.text = currentContent
            }
          }

          yield {
            type: 'content_block_delta',
            index: blockIndex - 1,
            delta: {
              type: 'text_delta',
              text: textContent,
            },
          } as BetaRawContentBlockDeltaEvent
        }
      } else if (event.type === 'content_block_stop') {
        // Emit content block stop
        if (blockStarted) {
          yield {
            type: 'content_block_stop',
            index: blockIndex - 1,
          } as BetaRawContentBlockStopEvent
          blockStarted = false
        }
      } else if (event.type === 'message_delta') {
        // Track stop reason and tokens
        const stopReason = (event as any)?.stopReason
        if (stopReason) {
          finishReason = stopReason
        }
        const usage = (event as any)?.usage
        if (usage) {
          outputTokens = usage.output_tokens || outputTokens
        }

        yield {
          type: 'message_delta',
          delta: {
            stop_reason: finishReason || 'end_turn',
            stop_sequence: null,
          },
          usage: {
            input_tokens: inputTokens,
            output_tokens: outputTokens,
            cache_creation_input_tokens: 0,
            cache_read_input_tokens: 0,
          } as any,
        } as BetaRawMessageDeltaEvent
      } else if (event.type === 'message_stop') {
        // Extract final metadata
        const usage = (event as any)?.message?.usage || (event as any)?.usage
        const stopReason = (event as any)?.message?.stopReason || (event as any)?.stopReason
        if (usage) {
          inputTokens = usage.inputTokens || usage.input_tokens || inputTokens
          outputTokens = usage.outputTokens || usage.output_tokens || outputTokens
        }
        if (stopReason) {
          finishReason = stopReason === 'end_turn' ? 'end_turn' : 'stop_sequence'
        }

        // Auto-emit content_block_stop if block was started
        if (blockStarted) {
          yield {
            type: 'content_block_stop',
            index: blockIndex - 1,
          } as BetaRawContentBlockStopEvent
          blockStarted = false
        }

        // Emit message_delta with final usage
        yield {
          type: 'message_delta',
          delta: {
            stop_reason: finishReason || 'end_turn',
            stop_sequence: null,
          },
          usage: {
            input_tokens: inputTokens,
            output_tokens: outputTokens,
            cache_creation_input_tokens: 0,
            cache_read_input_tokens: 0,
          } as any,
        } as BetaRawMessageDeltaEvent
      }
    }

    // Emit final message stop event
    yield {
      type: 'message_stop',
    } as BetaRawMessageStopEvent
  } catch (error) {
    // On error, emit a stop event to gracefully close the stream
    console.error('[streamAdapter] Stream error:', error)
    yield {
      type: 'message_stop',
    } as BetaRawMessageStopEvent
    throw error
  }
}

/**
 * Converts a complete LLM response to Anthropic SDK message format
 * 
 * Usage:
 * ```typescript
 * const response = await provider.complete(options);
 * const anthropicMessage = convertLLMResponseToAnthropicMessage(response);
 * ```
 */
export function convertLLMResponseToAnthropicMessage(
  response: LLMResponse,
  messageId: string = generateMessageId(),
): any {
  // Create content blocks from response
  const contentBlocks = response.content.map(c => ({
    type: 'text' as const,
    text: c.text || '',
  }))

  const tokens = (response as any).tokens || { input: 0, output: 0 }

  return {
    id: messageId,
    type: 'message',
    role: 'assistant',
    content: contentBlocks,
    model: response.model || 'unknown',
    stop_reason: response.stopReason || 'end_turn',
    stop_sequence: null,
    usage: {
      input_tokens: tokens.input || 0,
      output_tokens: tokens.output || 0,
    },
  }
}

/**
 * Generates a unique message ID matching Anthropic's format
 * Format: msg_nnnnnnnnnnnnnnnnnnnnnnnn (25 chars, alphanumeric after "msg_")
 */
export function generateMessageId(): string {
  const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
  let id = 'msg_';
  for (let i = 0; i < 20; i++) {
    id += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return id;
}

/**
 * Helper to convert LLMStreamEvent to BetaRawMessageStreamEvent
 * Used for direct event mapping (lower-level than createStreamAdapter)
 */
export function convertLLMEventToAnthropicEvent(
  event: LLMStreamEvent,
  blockIndex: number = 0,
): BetaRawMessageStreamEvent | null {
  switch (event.type) {
    case 'message_start':
      return {
        type: 'message_start',
        message: {
          id: generateMessageId(),
          type: 'message',
          role: 'assistant',
          content: [],
          model: 'unknown',
          stop_reason: null,
          stop_sequence: null,
          usage: {
            input_tokens: 0,
            output_tokens: 0,
            cache_creation_input_tokens: 0,
            cache_read_input_tokens: 0,
          } as any,
        },
      } as BetaRawMessageStartEvent

    case 'content_block_start':
      return {
        type: 'content_block_start',
        index: blockIndex,
        content_block: {
          type: 'text',
          text: '',
        } as any,
      } as BetaRawContentBlockStartEvent

    case 'content_block_delta':
      const textContent = (event as any)?.text || ''
      if (textContent) {
        return {
          type: 'content_block_delta',
          index: blockIndex,
          delta: {
            type: 'text_delta',
            text: textContent,
          },
        } as BetaRawContentBlockDeltaEvent
      }
      return null

    case 'content_block_stop':
      return {
        type: 'content_block_stop',
        index: blockIndex,
      } as BetaRawContentBlockStopEvent

    case 'message_delta':
      return {
        type: 'message_delta',
        delta: {
          stop_reason: 'end_turn',
          stop_sequence: null,
        },
        usage: {
          input_tokens: 0,
          output_tokens: 0,
          cache_creation_input_tokens: 0,
          cache_read_input_tokens: 0,
        } as any,
      } as BetaRawMessageDeltaEvent

    case 'message_stop':
      return {
        type: 'message_stop',
      } as BetaRawMessageStopEvent

    default:
      return null
  }
}
