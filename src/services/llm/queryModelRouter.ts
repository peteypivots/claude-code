/**
 * Query Model Router - Local-First LLM Routing
 * 
 * Routes model calls to local Ollama or Claude based on task complexity.
 * Drop-in replacement for queryModelWithStreaming in deps.ts.
 */

import { randomUUID, type UUID } from 'crypto'
import type {
  BetaMessage,
  BetaRawMessageStreamEvent,
  BetaContentBlock,
  BetaToolUseBlock,
} from '@anthropic-ai/sdk/resources/beta/messages/messages.mjs'
import { OllamaProvider } from './ollamaClient.js'
import type { LLMStreamEvent, LLMRequestOptions, MessageContent } from './types.js'
import {
  getRoutingDecision,
  clearRoutingCache,
  getCacheStats,
  type RoutingContext,
  type RoutingDecision as OrchestratorDecision,
} from './orchestratorModel.js'
import { reason as invokeReasoning } from './reasoningProvider.js'
import { getModelPool, type ModelTier } from './modelPool.js'
import type {
  AssistantMessage,
  Message,
  StreamEvent,
  SystemAPIErrorMessage,
} from '../../types/message.js'
import type { SystemPrompt } from '../../utils/systemPromptType.js'
import type { Tools } from '../../Tool.js'

// ThinkingConfig type (defined locally to avoid missing module)
interface ThinkingConfig {
  type: 'enabled' | 'disabled'
  budgetTokens?: number
}

// ============================================================================
// Configuration
// ============================================================================

export interface RouterConfig {
  /** Enable local-first routing (default: true if OLLAMA_BASE_URL is set) */
  enabled: boolean
  /** Ollama base URL */
  ollamaBaseUrl: string
  /** Model for local inference (default: qwen2.5:7b-instruct) */
  localModel: string
  /** Max chars before escalating to Claude (proxy for complexity) - static fallback */
  complexityThreshold: number
  /** Log routing decisions */
  verbose: boolean
  /** Use LLM-based orchestrator for routing (default: true) */
  useLLMOrchestrator: boolean
  /** Cache TTL for routing decisions in ms (default: 5 minutes) */
  routingCacheTtlMs: number
}

const DEFAULT_CONFIG: RouterConfig = {
  enabled: !!process.env.OLLAMA_BASE_URL || process.env.LOCAL_FIRST === 'true',
  ollamaBaseUrl: process.env.OLLAMA_BASE_URL || 'http://localhost:11434',
  localModel: process.env.LOCAL_MODEL || 'qwen2.5:7b-instruct',
  complexityThreshold: 8000,  // ~2000 tokens
  verbose: process.env.ROUTER_VERBOSE === 'true',
  useLLMOrchestrator: process.env.USE_LLM_ORCHESTRATOR !== 'false',
  routingCacheTtlMs: parseInt(process.env.ROUTER_CACHE_TTL_MS || '300000', 10),
}

// ============================================================================
// Routing Logic
// ============================================================================

interface RoutingDecision {
  useLocal: boolean
  reason: string
  model: string
  action?: 'local' | 'reason' | 'escalate'
  suggestedTool?: string
}

/**
 * Get routing decision using LLM orchestrator or static rules
 * This is async because it may call the orchestrator model
 */
export async function getRoutingDecisionAsync(
  messages: Message[],
  tools: Tools,
  config: RouterConfig = DEFAULT_CONFIG,
): Promise<RoutingDecision> {
  if (!config.enabled) {
    return { useLocal: false, reason: 'routing_disabled', model: 'claude' }
  }

  // Get last user message content
  const lastUserMsg = [...messages].reverse().find(m => m.type === 'user')
  if (!lastUserMsg || lastUserMsg.type !== 'user') {
    return { useLocal: true, reason: 'no_user_message', model: config.localModel }
  }

  const content = typeof lastUserMsg.message.content === 'string'
    ? lastUserMsg.message.content
    : lastUserMsg.message.content
        .filter(c => c.type === 'text')
        .map(c => (c as { text: string }).text)
        .join(' ')

  // Try LLM orchestrator if enabled
  if (config.useLLMOrchestrator) {
    try {
      const toolNames = tools.map(t => t.name)
      const context: RoutingContext = {
        userMessage: content,
        toolCount: tools.length,
        conversationDepth: messages.filter(m => m.type === 'assistant').length,
        toolNames,
      }

      const orchestratorDecision = await getRoutingDecision(context, {
        cacheTtlMs: config.routingCacheTtlMs,
        verbose: config.verbose,
      })

      if (config.verbose) {
        console.log(`[Router] Orchestrator decision: ${orchestratorDecision.action} (${orchestratorDecision.reasoning})`)
      }

      return mapOrchestratorDecision(orchestratorDecision, config)
    } catch (error) {
      if (config.verbose) {
        console.warn('[Router] Orchestrator failed, falling back to static rules:', error)
      }
      // Fall through to static rules
    }
  }

  // Static fallback
  return shouldUseLocalModelStatic(messages, tools, config)
}

/**
 * Map orchestrator decision to router decision
 */
function mapOrchestratorDecision(
  decision: OrchestratorDecision,
  config: RouterConfig,
): RoutingDecision {
  switch (decision.action) {
    case 'local':
      return {
        useLocal: true,
        reason: decision.reasoning,
        model: decision.model || config.localModel,
        action: 'local',
        suggestedTool: decision.suggestedTool,
      }

    case 'reason':
      // Use reasoning model (deepseek-r1)
      return {
        useLocal: true,
        reason: decision.reasoning,
        model: decision.model || 'deepseek-r1:7b',
        action: 'reason',
        suggestedTool: decision.suggestedTool,
      }

    case 'escalate':
      return {
        useLocal: false,
        reason: decision.reasoning,
        model: decision.model || 'claude-sonnet-4-20250514',
        action: 'escalate',
        suggestedTool: decision.suggestedTool,
      }

    default:
      return {
        useLocal: true,
        reason: 'default',
        model: config.localModel,
        action: 'local',
      }
  }
}

/**
 * Static routing rules (fallback when orchestrator unavailable)
 * @deprecated Use getRoutingDecisionAsync instead
 */
export function shouldUseLocalModel(
  messages: Message[],
  tools: Tools,
  config: RouterConfig = DEFAULT_CONFIG,
): RoutingDecision {
  return shouldUseLocalModelStatic(messages, tools, config)
}

/**
 * Static routing rules implementation
 */
function shouldUseLocalModelStatic(
  messages: Message[],
  tools: Tools,
  config: RouterConfig = DEFAULT_CONFIG,
): RoutingDecision {
  if (!config.enabled) {
    return { useLocal: false, reason: 'routing_disabled', model: 'claude' }
  }

  // Get last user message
  const lastUserMsg = [...messages].reverse().find(m => m.type === 'user')
  if (!lastUserMsg || lastUserMsg.type !== 'user') {
    return { useLocal: true, reason: 'no_user_message', model: config.localModel }
  }

  const content = typeof lastUserMsg.message.content === 'string'
    ? lastUserMsg.message.content
    : lastUserMsg.message.content
        .filter(c => c.type === 'text')
        .map(c => (c as { text: string }).text)
        .join(' ')

  // Check for explicit escalation keywords
  const escalationKeywords = [
    'complex', 'architect', 'refactor entire', 'security review',
    'explain in detail', 'comprehensive', 'analyze deeply',
    'design pattern', 'full implementation',
  ]
  
  if (escalationKeywords.some(kw => content.toLowerCase().includes(kw))) {
    return { useLocal: false, reason: 'escalation_keyword', model: 'claude' }
  }

  // Check message length (proxy for complexity)
  if (content.length > config.complexityThreshold) {
    return { useLocal: false, reason: 'long_input', model: 'claude' }
  }

  // Check tool count - many tools = complex task
  if (tools.length > 20) {
    return { useLocal: false, reason: 'many_tools', model: 'claude' }
  }

  // Check conversation depth
  const assistantMsgCount = messages.filter(m => m.type === 'assistant').length
  if (assistantMsgCount > 25) {
    return { useLocal: false, reason: 'deep_conversation', model: 'claude' }
  }

  // Default: use local
  return { useLocal: true, reason: 'default', model: config.localModel }
}

// ============================================================================
// Ollama Provider Singleton
// ============================================================================

let ollamaProvider: OllamaProvider | null = null

function getOllamaProvider(config: RouterConfig = DEFAULT_CONFIG): OllamaProvider {
  if (!ollamaProvider) {
    ollamaProvider = new OllamaProvider({
      baseUrl: config.ollamaBaseUrl,
      timeout: 120000,
      retries: 2,
    })
  }
  return ollamaProvider
}

// ============================================================================
// Message Conversion
// ============================================================================

/**
 * Convert internal Message[] to LLM provider format
 */
function convertMessagesToLLM(messages: Message[]): LLMRequestOptions['messages'] {
  return messages
    .filter(m => m.type === 'user' || m.type === 'assistant')
    .map(m => {
      if (m.type === 'user') {
        const content = m.message.content
        if (typeof content === 'string') {
          return { role: 'user' as const, content }
        }
        
        // Convert content blocks
        const converted: MessageContent[] = content.map(c => {
          if (c.type === 'text') {
            return { type: 'text' as const, text: c.text }
          }
          if (c.type === 'tool_result') {
            return {
              type: 'tool_result' as const,
              id: (c as { tool_use_id: string }).tool_use_id,
              content: typeof c.content === 'string' ? c.content : JSON.stringify(c.content),
            }
          }
          return { type: 'text' as const, text: JSON.stringify(c) }
        })
        
        return { role: 'user' as const, content: converted }
      } else {
        // Assistant message
        const content = m.message.content
        const converted: MessageContent[] = content.map(c => {
          if (c.type === 'text') {
            return { type: 'text' as const, text: c.text }
          }
          if (c.type === 'tool_use') {
            return {
              type: 'tool_use' as const,
              id: c.id,
              name: c.name,
              input: c.input as Record<string, unknown>,
            }
          }
          return { type: 'text' as const, text: '' }
        })
        
        return { role: 'assistant' as const, content: converted }
      }
    })
}

/**
 * Convert Tools to Anthropic tool format for Ollama
 */
function convertToolsToLLM(tools: Tools): LLMRequestOptions['tools'] {
  return tools.map(tool => {
    // Extract properties from Zod schema if available
    const schema = tool.inputSchema as { shape?: Record<string, unknown>; _def?: { shape?: () => Record<string, unknown> } }
    let properties: Record<string, unknown> = {}
    
    if (schema.shape) {
      properties = schema.shape
    } else if (schema._def?.shape) {
      properties = schema._def.shape()
    }
    
    return {
      name: tool.name,
      description: tool.description || '',
      input_schema: {
        type: 'object' as const,
        properties,
        required: [] as string[],
      },
    }
  })
}

/**
 * Convert LLM response content to BetaContentBlock[]
 */
function convertToBetaContent(content: MessageContent[]): BetaContentBlock[] {
  return content.map(c => {
    if (c.type === 'text') {
      return { type: 'text' as const, text: c.text || '' } as BetaContentBlock
    }
    if (c.type === 'tool_use') {
      return {
        type: 'tool_use' as const,
        id: c.id || `toolu_${Date.now().toString(36)}`,
        name: c.name || '',
        input: c.input || {},
      } as BetaToolUseBlock
    }
    return { type: 'text' as const, text: '' } as BetaContentBlock
  })
}

/**
 * Create AssistantMessage from LLM response
 */
function createAssistantMessage(
  content: MessageContent[],
  model: string,
  usage: { inputTokens: number; outputTokens: number },
): AssistantMessage {
  const betaContent = convertToBetaContent(content)
  const hasToolUse = content.some(c => c.type === 'tool_use')

  const betaMessage: BetaMessage = {
    id: `msg_local_${Date.now().toString(36)}`,
    type: 'message',
    role: 'assistant',
    content: betaContent,
    model,
    stop_reason: hasToolUse ? 'tool_use' : 'end_turn',
    stop_sequence: null,
    usage: {
      input_tokens: usage.inputTokens,
      output_tokens: usage.outputTokens,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
    },
  }

  return {
    type: 'assistant',
    uuid: randomUUID() as UUID,
    timestamp: new Date().toISOString(),
    message: betaMessage,
  }
}

// ============================================================================
// Streaming Conversion
// ============================================================================

/**
 * Convert LLM stream event to Anthropic StreamEvent
 */
function convertToStreamEvent(event: LLMStreamEvent, model: string): StreamEvent | null {
  if (event.type === 'content_block_delta') {
    const delta = (event as { delta?: { text?: string } }).delta
    if (delta?.text) {
      return {
        type: 'stream_event',
        event: {
          type: 'content_block_delta',
          index: 0,
          delta: {
            type: 'text_delta',
            text: delta.text,
          },
        } as BetaRawMessageStreamEvent,
      }
    }
  }

  if (event.type === 'content_block_start') {
    const block = (event as { content_block?: { type: string; name?: string; id?: string; input?: unknown } }).content_block
    if (block?.type === 'tool_use') {
      return {
        type: 'stream_event',
        event: {
          type: 'content_block_start',
          index: 0,
          content_block: {
            type: 'tool_use',
            id: block.id || `toolu_${Date.now().toString(36)}`,
            name: block.name || '',
            input: block.input || {},
          },
        } as BetaRawMessageStreamEvent,
      }
    }
  }

  return null
}

// ============================================================================
// Main Router Function
// ============================================================================

export interface QueryModelParams {
  messages: Message[]
  systemPrompt: SystemPrompt
  thinkingConfig: ThinkingConfig
  tools: Tools
  signal: AbortSignal
  options: {
    model?: string
    fallbackModel?: string
    querySource?: string
    [key: string]: unknown
  }
}

/**
 * Route model calls to local Ollama or Claude
 * Drop-in replacement for queryModelWithStreaming
 * 
 * Uses LLM-based orchestrator to decide:
 * - 'local' → qwen2.5:7b for simple tasks
 * - 'reason' → deepseek-r1:7b for reasoning tasks
 * - 'escalate' → Claude for complex/creative tasks
 */
export async function* queryModelWithRouting(
  params: QueryModelParams,
  config: RouterConfig = DEFAULT_CONFIG,
): AsyncGenerator<StreamEvent | AssistantMessage | SystemAPIErrorMessage, void> {
  const { messages, systemPrompt, tools, signal } = params

  // Get routing decision (async - may call orchestrator)
  const decision = await getRoutingDecisionAsync(messages, tools, config)

  if (config.verbose) {
    console.log(`[Router] Decision: ${decision.action || (decision.useLocal ? 'LOCAL' : 'CLAUDE')} - ${decision.reason}`)
    if (decision.suggestedTool) {
      console.log(`[Router] Suggested first tool: ${decision.suggestedTool}`)
    }
  }

  // Handle escalation to Claude
  if (!decision.useLocal) {
    const { queryModelWithStreaming } = await import('../api/claude.js')
    yield* queryModelWithStreaming(params as Parameters<typeof queryModelWithStreaming>[0])
    recordClaudeCall(0) // Will be updated by actual call
    return
  }

  // Handle reasoning action - prepend reasoning step
  if (decision.action === 'reason') {
    yield* handleReasoningAction(params, decision, config)
    return
  }

  // Handle local action
  yield* handleLocalAction(params, decision, config)
}

/**
 * Handle reasoning action - invoke DeepSeek-R1 first, then continue
 */
async function* handleReasoningAction(
  params: QueryModelParams,
  decision: RoutingDecision,
  config: RouterConfig,
): AsyncGenerator<StreamEvent | AssistantMessage | SystemAPIErrorMessage, void> {
  const lastUserMsg = [...params.messages].reverse().find(m => m.type === 'user')
  if (!lastUserMsg || lastUserMsg.type !== 'user') {
    // Fallback to local
    yield* handleLocalAction(params, decision, config)
    return
  }

  const userContent = typeof lastUserMsg.message.content === 'string'
    ? lastUserMsg.message.content
    : lastUserMsg.message.content
        .filter(c => c.type === 'text')
        .map(c => (c as { text: string }).text)
        .join(' ')

  try {
    // Invoke reasoning model
    if (config.verbose) {
      console.log('[Router] Invoking reasoning model...')
    }

    const reasoningResult = await invokeReasoning({
      problem: userContent,
      maxTokens: 2048,
    }, {
      verbose: config.verbose,
    })

    if (config.verbose) {
      console.log(`[Router] Reasoning complete (${reasoningResult.durationMs}ms), confidence: ${reasoningResult.confidence}`)
    }

    // Yield reasoning as a text block
    const reasoningText = `**Reasoning:**\n${reasoningResult.reasoning}\n\n**Answer:**\n${reasoningResult.answer}`
    
    // Create assistant message with reasoning
    const content: MessageContent[] = [{ type: 'text', text: reasoningText }]
    
    yield createAssistantMessage(content, 'deepseek-r1:7b', reasoningResult.usage)
    recordLocalCall(reasoningResult.usage.inputTokens + reasoningResult.usage.outputTokens)

  } catch (error) {
    if (config.verbose) {
      console.error('[Router] Reasoning failed, falling back to local:', error)
    }
    // Fallback to regular local model
    yield* handleLocalAction(params, { ...decision, model: config.localModel }, config)
  }
}

/**
 * Handle local action - use Ollama worker model
 */
async function* handleLocalAction(
  params: QueryModelParams,
  decision: RoutingDecision,
  config: RouterConfig,
): AsyncGenerator<StreamEvent | AssistantMessage | SystemAPIErrorMessage, void> {
  const { messages, systemPrompt, tools, signal } = params

  // Use local model
  const provider = getOllamaProvider(config)
  
  // Check availability
  const available = await provider.isAvailable()
  if (!available) {
    if (config.verbose) {
      console.log('[Router] Ollama unavailable, escalating to Claude')
    }
    const { queryModelWithStreaming } = await import('../api/claude.js')
    yield* queryModelWithStreaming(params as Parameters<typeof queryModelWithStreaming>[0])
    recordClaudeCall(0)
    return
  }

  try {
    const llmMessages = convertMessagesToLLM(messages)
    const llmTools = convertToolsToLLM(tools)

    // Extract system prompt text
    const systemPromptText = typeof systemPrompt === 'string' 
      ? systemPrompt 
      : Array.isArray(systemPrompt)
        ? systemPrompt.map(p => typeof p === 'string' ? p : (p as { text?: string }).text || '').join('\n')
        : (systemPrompt as { text?: string }).text || ''

    // Stream from local model
    const stream = provider.stream({
      model: decision.model,
      messages: llmMessages,
      systemPrompt: systemPromptText,
      tools: llmTools,
      maxTokens: 4096,
    })

    let accumulatedContent: MessageContent[] = []
    let accumulatedText = ''
    let usage = { inputTokens: 0, outputTokens: 0 }

    for await (const event of stream) {
      // Check abort
      if (signal.aborted) {
        throw new Error('Request aborted')
      }

      // Convert and yield stream events
      const streamEvent = convertToStreamEvent(event, decision.model)
      if (streamEvent) {
        yield streamEvent
      }

      // Accumulate content for final message
      if (event.type === 'content_block_delta') {
        const delta = (event as { delta?: { text?: string } }).delta
        if (delta?.text) {
          accumulatedText += delta.text
        }
      }

      if (event.type === 'content_block_start') {
        const block = (event as { content_block?: MessageContent }).content_block
        if (block?.type === 'tool_use') {
          accumulatedContent.push(block)
        }
      }

      if (event.type === 'message_stop') {
        const msg = (event as { message?: { content?: MessageContent[]; usage?: typeof usage } }).message
        if (msg?.content) {
          accumulatedContent = msg.content
        }
        if (msg?.usage) {
          usage = msg.usage
        }
      }
    }

    // Build final content
    if (accumulatedContent.length === 0 && accumulatedText) {
      accumulatedContent = [{ type: 'text', text: accumulatedText }]
    }

    // Yield final assistant message
    yield createAssistantMessage(accumulatedContent, decision.model, usage)
    recordLocalCall(usage.inputTokens + usage.outputTokens)

  } catch (error) {
    if (config.verbose) {
      console.error('[Router] Local model error, escalating to Claude:', error)
    }
    
    // Fallback to Claude on error
    const { queryModelWithStreaming } = await import('../api/claude.js')
    yield* queryModelWithStreaming(params as Parameters<typeof queryModelWithStreaming>[0])
    recordClaudeCall(0)
  }
}

// ============================================================================
// Cost Tracking
// ============================================================================

interface CostStats {
  localCalls: number
  localTokens: number
  claudeCalls: number
  claudeTokens: number
  estimatedSavingsUSD: number
}

const costStats: CostStats = {
  localCalls: 0,
  localTokens: 0,
  claudeCalls: 0,
  claudeTokens: 0,
  estimatedSavingsUSD: 0,
}

export function getCostStats(): CostStats {
  return { ...costStats }
}

export function resetCostStats(): void {
  costStats.localCalls = 0
  costStats.localTokens = 0
  costStats.claudeCalls = 0
  costStats.claudeTokens = 0
  costStats.estimatedSavingsUSD = 0
}

export function recordLocalCall(tokens: number): void {
  costStats.localCalls++
  costStats.localTokens += tokens
  // Estimate savings: ~$0.003 per 1K tokens for Claude Sonnet
  costStats.estimatedSavingsUSD += (tokens / 1000) * 0.003
}

export function recordClaudeCall(tokens: number): void {
  costStats.claudeCalls++
  costStats.claudeTokens += tokens
}

// ============================================================================
// Exports
// ============================================================================

export { DEFAULT_CONFIG as defaultRouterConfig }
export { clearRoutingCache, getCacheStats }
