/**
 * Query Model Router - Local-First LLM Routing
 * 
 * Routes model calls to local Ollama or Claude based on task complexity.
 * Drop-in replacement for queryModelWithStreaming in deps.ts.
 */

import { randomUUID, type UUID } from 'crypto'
import { appendFileSync, writeFileSync } from 'fs'

const ROUTER_LOG = '/tmp/router-debug.log'
function routerLog(msg: string) {
  const line = `[${new Date().toISOString()}] [Router] ${msg}\n`
  try { appendFileSync(ROUTER_LOG, line) } catch {}
  // Write to PID 1 stderr so it appears in docker logs / promtail
  try { appendFileSync('/proc/1/fd/2', line) } catch {}
}

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
import { getEmptyToolPermissionContext, type Tools } from '../../Tool.js'
import { zodToJsonSchema } from '../../utils/zodToJsonSchema.js'

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
 * 
 * @param messages - Conversation messages
 * @param tools - Available tools
 * @param config - Router config
 * @param retryCount - Number of retries (for adaptive temperature)
 */
export async function getRoutingDecisionAsync(
  messages: Message[],
  tools: Tools,
  config: RouterConfig = DEFAULT_CONFIG,
  retryCount = 0,
): Promise<RoutingDecision> {
  if (!config.enabled) {
    return { useLocal: false, reason: 'routing_disabled', model: 'claude' }
  }

  // If no valid Anthropic key, skip orchestrator — escalation is impossible,
  // so just go straight to local and save the 5s orchestrator latency.
  const apiKey = process.env.ANTHROPIC_API_KEY
  if (!apiKey || apiKey.includes('YOUR_API_KEY')) {
    routerLog('No valid Anthropic key — skipping orchestrator, routing directly to local')
    return {
      useLocal: true,
      reason: 'no_claude_key_direct_local',
      model: config.localModel,
      action: 'local',
    }
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
      }, retryCount)

      if (config.verbose) {
        console.log(`[Router] Orchestrator decision: ${orchestratorDecision.action} (${orchestratorDecision.reasoning})${retryCount > 0 ? ` [retry #${retryCount}]` : ''}`)
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
      // If no valid Anthropic API key, force local — escalation would just
      // bounce through streamFromLLMProvider back to Ollama anyway
      if (!process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_API_KEY.includes('YOUR_API_KEY')) {
        routerLog(`Escalation overridden → local (no valid Anthropic key)`)
        return {
          useLocal: true,
          reason: `${decision.reasoning} [overridden→local: no Claude key]`,
          model: config.localModel,
          action: 'local',
          suggestedTool: decision.suggestedTool,
        }
      }
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

  // Tool count is not a complexity indicator — local model handles tools fine

  // Check conversation depth
  const assistantMsgCount = messages.filter(m => m.type === 'assistant').length
  if (assistantMsgCount > 25) {
    return { useLocal: false, reason: 'deep_conversation', model: 'claude' }
  }

  // Default: use local
  return { useLocal: true, reason: 'default', model: config.localModel }
}

// ============================================================================
// Loop Detection & Adaptive Temperature
// ============================================================================

// Track consecutive blocked tool attempts (per tool name)
const blockedToolAttempts = new Map<string, number>()
const MAX_BLOCKED_ATTEMPTS = 2 // Increased to allow temperature retries first

// Track retry count for current conversation (for adaptive temperature)
let conversationRetryCount = 0
const MAX_RETRIES = 3 // Max temperature retries before forcing end turn

/**
 * Detect if the model is stuck in a tool loop.
 * Returns the tool name if the same tool was called 3+ times consecutively.
 */
function detectToolLoop(messages: Message[], threshold = 3): string | null {
  // Collect the last N tool names from assistant messages
  const recentToolCalls: string[] = []
  
  // Walk backwards through messages
  for (let i = messages.length - 1; i >= 0 && recentToolCalls.length < threshold + 2; i--) {
    const msg = messages[i]
    if (msg?.type === 'assistant') {
      const toolUses = msg.message.content.filter((c: any) => c.type === 'tool_use')
      for (const tu of toolUses) {
        recentToolCalls.unshift((tu as { name: string }).name)
      }
    }
  }
  
  routerLog(`Loop check: recent tools = [${recentToolCalls.join(', ')}]`)
  
  // Check if the last `threshold` tools are the same
  if (recentToolCalls.length >= threshold) {
    const lastN = recentToolCalls.slice(-threshold)
    const allSame = lastN.every(t => t === lastN[0])
    if (allSame) {
      return lastN[0] as string
    }
  }
  
  return null
}

/**
 * Track blocked tool attempts. Returns true if we should force end the turn.
 * Also increments retry count for adaptive temperature.
 */
function trackBlockedTool(toolName: string): boolean {
  const attempts = (blockedToolAttempts.get(toolName) || 0) + 1
  blockedToolAttempts.set(toolName, attempts)
  conversationRetryCount++
  routerLog(`Blocked tool "${toolName}" attempt #${attempts}, conversation retry #${conversationRetryCount}`)
  return attempts >= MAX_BLOCKED_ATTEMPTS && conversationRetryCount >= MAX_RETRIES
}

/**
 * Get current retry count for adaptive temperature
 */
export function getConversationRetryCount(): number {
  return conversationRetryCount
}

/**
 * Reset blocked tool tracking (call at start of new user message)
 */
function resetBlockedToolTracking(): void {
  blockedToolAttempts.clear()
  conversationRetryCount = 0
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
  // Debug: log message types being received
  routerLog(`convertMessagesToLLM: ${messages.length} messages total`)
  for (const m of messages) {
    if (m.type === 'user') {
      const content = m.message.content
      const hasToolResult = Array.isArray(content) && content.some((c: any) => c.type === 'tool_result')
      routerLog(`  - user message: hasToolResult=${hasToolResult}, content=${typeof content === 'string' ? content.substring(0, 50) : `array[${content.length}]`}`)
    } else if (m.type === 'assistant') {
      const hasToolUse = m.message.content.some((c: any) => c.type === 'tool_use')
      routerLog(`  - assistant message: hasToolUse=${hasToolUse}`)
    } else {
      routerLog(`  - ${m.type} message (filtered out)`)
    }
  }
  
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
 * Convert Tools to Anthropic tool format for Ollama.
 * Must be async because tool.prompt() is async.
 * 
 * If OLLAMA_MINIMAL_TOOL_DESC=true, use minimal descriptions (for pre-trained models
 * that already know tool semantics from training data).
 */
async function convertToolsToLLM(tools: Tools): Promise<LLMRequestOptions['tools']> {
  const useMinimalDesc = process.env.OLLAMA_MINIMAL_TOOL_DESC === 'true'
  
  return Promise.all(tools.map(async tool => {
    // Use inputJSONSchema if available (MCP tools), otherwise convert Zod schema
    const jsonSchema = ('inputJSONSchema' in tool && tool.inputJSONSchema)
      ? tool.inputJSONSchema
      : zodToJsonSchema(tool.inputSchema)

    // Get tool description
    let description = tool.name
    
    if (useMinimalDesc) {
      // For pre-trained models: just use the tool name + searchHint if available
      // The model already knows what each tool does from training
      description = (tool as any).searchHint 
        ? `${tool.name}: ${(tool as any).searchHint}`
        : tool.name
    } else {
      // Full descriptions for models that need them
      try {
        description = await tool.prompt({
          getToolPermissionContext: getEmptyToolPermissionContext,
          tools,
          agents: [],
        })
      } catch (err) {
        // prompt() may throw if it needs context we don't have; use name
        routerLog(`tool.prompt() failed for ${tool.name}: ${err instanceof Error ? err.message : String(err)}`)
      }
    }

    return {
      name: tool.name,
      description,
      input_schema: {
        type: 'object' as const,
        properties: (jsonSchema as Record<string, unknown>).properties as Record<string, unknown> || {},
        required: (jsonSchema as Record<string, unknown>).required as string[] || [],
      },
    }
  }))
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

  // Reset blocked tool tracking when we see a new user message (no assistant messages yet)
  // This allows a clean slate for each new user query
  const hasAssistantMessages = messages.some(m => m.type === 'assistant')
  if (!hasAssistantMessages) {
    resetBlockedToolTracking()
  }

  routerLog(`=== queryModelWithRouting called ===`)
  routerLog(`Tools count: ${tools?.length || 0}`)
  routerLog(`Tool names: ${tools?.map(t => t.name).join(', ') || 'none'}`)
  routerLog(`Config enabled: ${config.enabled}, useLLMOrchestrator: ${config.useLLMOrchestrator}`)
  routerLog(`Conversation retry count: ${conversationRetryCount}`)

  // Get routing decision (async - may call orchestrator with adaptive temperature)
  let decision = await getRoutingDecisionAsync(messages, tools, config, conversationRetryCount)

  routerLog(`Decision: action=${decision.action}, useLocal=${decision.useLocal}, reason=${decision.reason}, model=${decision.model}, suggestedTool=${decision.suggestedTool || 'none'}`)

  if (config.verbose) {
    console.log(`[Router] Decision: ${decision.action || (decision.useLocal ? 'LOCAL' : 'CLAUDE')} - ${decision.reason}`)
    if (decision.suggestedTool) {
      console.log(`[Router] Suggested first tool: ${decision.suggestedTool}`)
    }
  }

  // Handle escalation to Claude (with fallback to local+tools if Claude fails)
  if (!decision.useLocal) {
    try {
      const { queryModelWithStreaming } = await import('../api/claude.js')
      yield* queryModelWithStreaming(params as Parameters<typeof queryModelWithStreaming>[0])
      recordClaudeCall(0)
      return
    } catch (error) {
      routerLog(`Claude escalation failed, falling back to local with tools: ${error}`)
      // Fall through to local model with tools instead of failing
      decision = { ...decision, useLocal: true, model: config.localModel, action: 'local', reason: 'claude_fallback' }
    }
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

  // Detect tool loops
  const loopedTool = detectToolLoop(messages)
  if (loopedTool) {
    routerLog(`LOOP DETECTED: tool "${loopedTool}" called 3+ times consecutively`)
  }

  try {
    const llmMessages = convertMessagesToLLM(messages)
    const llmTools = await convertToolsToLLM(tools)

    routerLog(`handleLocalAction: model=${decision.model}, tools=${llmTools?.length || 0}`)
    if (llmTools && llmTools.length > 0) {
      // Log first 3 tool schemas to verify format
      for (const t of llmTools.slice(0, 3)) {
        routerLog(`  Tool: ${t.name} - desc length: ${t.description?.length || 0} - props: ${JSON.stringify(Object.keys(t.input_schema?.properties || {}))}`)
      }
    }

    // Extract system prompt text
    let systemPromptText = typeof systemPrompt === 'string' 
      ? systemPrompt 
      : Array.isArray(systemPrompt)
        ? systemPrompt.map(p => typeof p === 'string' ? p : (p as { text?: string }).text || '').join('\n')
        : (systemPrompt as { text?: string }).text || ''

    // If the orchestrator suggested a tool, hint the model to use it
    if (decision.suggestedTool) {
      systemPromptText += `\n\nIMPORTANT: For this query, you should use the "${decision.suggestedTool}" tool. Do NOT answer from memory — invoke the tool first.`
    }

    // Check if we already have web search results in the conversation - if so, tell the model to answer
    let webSearchContent: string | null = null
    for (const m of messages) {
      // Messages use 'type' not 'role', and user content is in m.message.content
      if (m.type === 'user') {
        const msgContent = (m as any).message?.content
        if (Array.isArray(msgContent)) {
          for (const c of msgContent) {
            if (c.type === 'tool_result') {
              const content = typeof c.content === 'string' 
                ? c.content 
                : JSON.stringify(c.content)
              if (content.includes('Web search results for query') || content.includes('Key information found')) {
                webSearchContent = content
                routerLog('Detected web search results in conversation')
                break
              }
            }
          }
          if (webSearchContent) break
        }
      }
    }
    
    if (webSearchContent) {
      systemPromptText += `\n\n🔍 WEB SEARCH COMPLETED: You have already received web search results below. Do NOT call any more tools. Use the search results to directly answer the user's original question. Respond with a helpful, concise answer based on what you found.\n\nSearch results:\n${webSearchContent.substring(0, 2000)}`
      routerLog('Detected web search results in conversation, adding answer instruction')
    }

    // If we're in a loop, inject nudge AND remove the looped tool
    let filteredTools = llmTools
    let forceEndTurn = false
    if (loopedTool) {
      // Track this block and check if we should force end the turn
      forceEndTurn = trackBlockedTool(loopedTool)
      
      if (forceEndTurn) {
        routerLog(`Forcing end turn after ${MAX_BLOCKED_ATTEMPTS} blocked attempts for "${loopedTool}"`)
        
        // If we have web search results, force an answer based on them
        if (webSearchContent) {
          // Extract key info from search results
          const keyInfoMatch = webSearchContent.match(/Key information found:\n([\s\S]*?)(?:\n\n|Links:|$)/)
          const answerInfo = keyInfoMatch ? keyInfoMatch[1].trim() : webSearchContent.substring(0, 500)
          
          // Get the original question from messages
          const originalQuestion = messages.find(m => 
            m.role === 'user' && 
            typeof m.content === 'string' &&
            !m.content.includes('tool_result')
          )?.content as string || 'your question'
          
          const forceEndMessage = `Based on the web search results:\n\n${answerInfo}\n\nI found the information you were looking for. Let me know if you need more details!`
          
          yield {
            type: 'message_start',
            message: {
              id: `msg_${Date.now().toString(36)}`,
              type: 'message',
              role: 'assistant',
              content: [],
              model: decision.model,
            },
          } as StreamEvent
          
          yield createAssistantMessage(
            [{ type: 'text', text: forceEndMessage }],
            decision.model,
            { inputTokens: 0, outputTokens: 0 }
          )
          return
        }
        
        // Default force end for non-search situations
        const forceEndMessage = `I apologize, but I'm having difficulty completing this task. I've attempted to use ${loopedTool} multiple times but it doesn't seem to be providing the information needed.\n\nPlease try rephrasing your question or ask me to use a different approach.`
        
        yield {
          type: 'message_start',
          message: {
            id: `msg_${Date.now().toString(36)}`,
            type: 'message',
            role: 'assistant',
            content: [],
            model: decision.model,
          },
        } as StreamEvent
        
        yield createAssistantMessage(
          [{ type: 'text', text: forceEndMessage }],
          decision.model,
          { inputTokens: 0, outputTokens: 0 }
        )
        return
      }
      
      systemPromptText += `\n\n⚠️ LOOP DETECTED: You have called "${loopedTool}" multiple times with the same result. You already have the information from this tool. The tool "${loopedTool}" has been DISABLED for this turn. Instead:\n- If you have enough information, provide your final answer\n- If you need different information, use a DIFFERENT tool (e.g., Bash, Glob, Read)\n- Do NOT attempt to call ${loopedTool}`
      
      // Actually remove the looped tool from available tools
      if (filteredTools) {
        filteredTools = filteredTools.filter(t => t.name !== loopedTool)
        routerLog(`Filtered out looped tool "${loopedTool}", ${filteredTools.length} tools remaining`)
      }
    }

    // Stream from local model
    const stream = provider.stream({
      model: decision.model,
      messages: llmMessages,
      systemPrompt: systemPromptText,
      tools: filteredTools,
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

    routerLog(`handleLocalAction result: ${accumulatedContent.length} content blocks`)
    for (const c of accumulatedContent) {
      if (c.type === 'tool_use') {
        routerLog(`  TOOL_USE: ${c.name} input=${JSON.stringify(c.input).substring(0, 200)}`)
      } else if (c.type === 'text') {
        routerLog(`  TEXT: ${(c.text || '').substring(0, 200)}`)
      }
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
