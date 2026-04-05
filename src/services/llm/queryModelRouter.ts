/**
 * Query Model Router - Local-First LLM Routing
 * 
 * Routes model calls to local Ollama or Claude based on task complexity.
 * Drop-in replacement for queryModelWithStreaming in deps.ts.
 */

import { randomUUID, type UUID } from 'crypto'
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs'
import { dirname, join } from 'path'
import { isEnvTruthy } from '../../utils/envUtils.js'
import { captureToolLoopRecovery, captureSuccessfulToolUse, captureMultiTurn, isCaptureEnabled } from './trainingCapture.js'
import { captureResearchFindings, isResearchCaptureEnabled } from './researchCapture.js'

const ROUTER_LOG = process.env.OLLAMA_DEBUG_LOG_FILE || '/data/logs/router-debug.log'

// ============================================================================
// Local System Prompt Cache (canopy-managed)
// ============================================================================

let _localPromptCache: string | null | undefined = undefined // undefined = not yet loaded

/**
 * Read the local model system prompt from canopy cache.
 * Populated by: cn render local-system > .claude/.local-prompt-cache
 * Falls back to a compact built-in prompt if cache is missing.
 */
function getLocalSystemPrompt(): string {
  if (_localPromptCache !== undefined) {
    return _localPromptCache || LOCAL_PROMPT_FALLBACK
  }

  const candidatePaths = [
    join(process.cwd(), '.claude', '.local-prompt-cache'),
    '/app/.claude/.local-prompt-cache',
  ]

  for (const p of candidatePaths) {
    if (!existsSync(p)) continue
    try {
      const content = readFileSync(p, 'utf-8')
      if (content.length > 50) {
        _localPromptCache = content
        routerLog(`Loaded local system prompt from cache: ${p} (${content.length} chars)`, 'success')
        return content
      }
    } catch {}
  }

  _localPromptCache = null
  routerLog('No local prompt cache found, using built-in fallback', 'warn')
  return LOCAL_PROMPT_FALLBACK
}

/**
 * Strip <system-reminder> blocks from text content, but preserve memory-related
 * sections (claudeMd, memory) that Ollama agents need for context.
 * 
 * The CLI framework injects these into user messages with the full Claude prompt,
 * CLAUDE.md, memory instructions, and git status — thousands of tokens that
 * overwhelm the local model. Our canopy system prompt already covers essentials,
 * but memory content is unique per-project and must be preserved.
 * 
 * IMPORTANT: When LOCAL_SYSTEM_PROMPT is set (agent/research mode), we strip
 * ALL system-reminder content including claudeMd. The agent has its own focused
 * system prompt and injecting CLAUDE.md causes the local model to regurgitate
 * internal instructions/tool names into external API calls (info leak to Meta AI).
 */
function stripSystemReminders(text: string): string {
  // In agent mode (LOCAL_SYSTEM_PROMPT set), strip everything — the agent
  // has its own system prompt and doesn't need CLAUDE.md context leaking
  // into tool call arguments sent to external APIs like Meta AI.
  const agentMode = !!(process.env.LOCAL_SYSTEM_PROMPT && process.env.LOCAL_SYSTEM_PROMPT.length > 50)

  return text.replace(/<system-reminder>([\s\S]*?)<\/system-reminder>/g, (_match, inner: string) => {
    if (agentMode) {
      // Agent mode: only preserve currentDate, strip claudeMd and memory
      // to prevent leaking internal instructions into external API queries
      const dateMatch = inner.match(/^# currentDate\n([\s\S]*?)(?=^# |\s*$)/m)
      if (dateMatch?.[1]?.trim()) {
        return `[currentDate]\n${dateMatch[1].trim()}`
      }
      return ''
    }

    // Normal mode: preserve claudeMd, memory, and currentDate
    const preserved: string[] = []
    
    // Match "# claudeMd\n..." or "# memory\n..." sections within the context
    // Each section starts with "# <key>\n" and runs until the next "# <key>\n" or end
    const sectionRegex = /^# (claudeMd|memory|currentDate)\n([\s\S]*?)(?=^# |\s*$)/gm
    let sectionMatch
    while ((sectionMatch = sectionRegex.exec(inner)) !== null) {
      const sectionName = sectionMatch[1]
      const sectionContent = sectionMatch[2]?.trim()
      if (sectionContent) {
        preserved.push(`[${sectionName}]\n${sectionContent}`)
      }
    }
    
    if (preserved.length > 0) {
      return preserved.join('\n\n')
    }
    return ''
  }).trim()
}

const LOCAL_PROMPT_FALLBACK = `You are Claude Code, an AI coding assistant running locally. Use the available tools to help the user.

## Tool Usage
Use tools to accomplish tasks. Do not guess when a tool can provide accurate information.
- Weather, news, current events → WebSearchTool
- Read a file → FileReadTool / ReadTool
- Edit a file → FileEditTool / FileWriteTool
- Run a command → BashTool
- Explore codebase → ListFilesTool, GlobTool, GrepTool
- Understand source → mcp tools (get_tool_source, read_source_file, search_source)

After receiving tool results, synthesize into a clear answer. Never fabricate results.
Be concise and direct. Use markdown for code blocks.`

// ANSI color codes for terminal output
const COLORS = {
  reset: '\x1b[0m',
  bright: '\x1b[1m',
  cyan: '\x1b[36m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  red: '\x1b[31m',
  magenta: '\x1b[35m',
  blue: '\x1b[34m',
}

function routerLog(msg: string, level: 'info' | 'warn' | 'error' | 'success' | 'debug' = 'info') {
  const timestamp = new Date().toISOString().substring(11, 23) // HH:MM:SS.mmm
  const line = `[${new Date().toISOString()}] [Router] ${msg}\n`
  try {
    mkdirSync(dirname(ROUTER_LOG), { recursive: true })
    appendFileSync(ROUTER_LOG, line)
  } catch {}
  
  // Colorized console output
  let color = COLORS.cyan
  let prefix = '🔵'
  switch (level) {
    case 'warn': color = COLORS.yellow; prefix = '⚠️'; break
    case 'error': color = COLORS.red; prefix = '❌'; break
    case 'success': color = COLORS.green; prefix = '✅'; break
    case 'debug': color = COLORS.magenta; prefix = '🔍'; break
  }
  
  const consoleMsg = `${color}${COLORS.bright}[${timestamp}]${COLORS.reset} ${prefix} ${msg}`
  console.error(consoleMsg)
  
  // Also write to PID 1 stderr for docker logs
  try { appendFileSync('/proc/1/fd/2', `[Router] ${msg}\n`) } catch {}
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
  confidence?: number
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

  // Do not skip the orchestrator when Anthropic key is missing.
  // The orchestrator itself runs locally (Ollama) and can still provide
  // useful tool suggestions (e.g., WebSearch) even when cloud escalation is
  // unavailable. Escalation is already overridden to local in
  // mapOrchestratorDecision() when no valid Claude key exists.

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
          return { role: 'user' as const, content: stripSystemReminders(content) }
        }
        
        // Convert content blocks
        const converted: MessageContent[] = content.map(c => {
          if (c.type === 'text') {
            const cleaned = stripSystemReminders(c.text)
            // Skip empty text blocks (fully stripped system-reminder)
            return { type: 'text' as const, text: cleaned }
          }
          if (c.type === 'tool_result') {
            return {
              type: 'tool_result' as const,
              id: (c as { tool_use_id: string }).tool_use_id,
              content: typeof c.content === 'string' ? c.content : JSON.stringify(c.content),
            }
          }
          return { type: 'text' as const, text: JSON.stringify(c) }
        }).filter(c => !(c.type === 'text' && !c.text))
        
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
 * Create AssistantMessage from LLM response, with optional training metadata.
 */
function createAssistantMessage(
  content: MessageContent[],
  model: string,
  usage: { inputTokens: number; outputTokens: number },
  trainingMeta?: {
    routingDecision?: 'local' | 'reason' | 'escalate'
    routingConfidence?: number
    latencyMs?: number
  },
): AssistantMessage {
  const betaContent = convertToBetaContent(content)
  const hasToolUse = content.some(c => c.type === 'tool_use')

  routerLog(`Creating AssistantMessage: content=${content.length} blocks, model=${model}`, 'debug')
  for (const c of content) {
    if (c.type === 'text') {
      routerLog(`  TEXT block: "${c.text?.substring(0, 80)}..."`, 'info')
    } else if (c.type === 'tool_use') {
      routerLog(`  TOOL_USE block: ${(c as any).name}`, 'info')
    }
  }

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

  routerLog(`AssistantMessage created: id=${betaMessage.id}, stop_reason=${betaMessage.stop_reason}`, 'success')

  return {
    type: 'assistant',
    uuid: randomUUID() as UUID,
    timestamp: new Date().toISOString(),
    message: betaMessage,
    modelUsed: model,
    routingDecision: trainingMeta?.routingDecision,
    routingConfidence: trainingMeta?.routingConfidence,
    latencyMs: trainingMeta?.latencyMs,
  }
}

// ============================================================================
// Streaming Conversion
// ============================================================================

// Counter for stream events to avoid overwhelming logs
let streamEventCount = 0

/**
 * Convert LLM stream event to Anthropic StreamEvent
 */
function convertToStreamEvent(event: LLMStreamEvent, model: string): StreamEvent | null {
  streamEventCount++
  
  // Log first few events and every 20th for debugging
  if (streamEventCount <= 3 || streamEventCount % 20 === 0) {
    routerLog(`[STREAM] Event #${streamEventCount}: type=${event.type}`, 'debug')
  }
  
  if (event.type === 'content_block_delta') {
    const delta = (event as { delta?: { text?: string } }).delta
    if (delta?.text) {
      if (streamEventCount <= 3) {
        routerLog(`[STREAM] Yielding text_delta: "${delta.text.substring(0, 30)}"`, 'success')
      }
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
      routerLog(`[STREAM] Yielding tool_use: ${block.name}`, 'success')
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
import { retrieveSimilarExamples, formatRAGContext } from './trainingRAG.js'

export async function* queryModelWithRouting(
  params: QueryModelParams,
  config: RouterConfig = DEFAULT_CONFIG,
): AsyncGenerator<StreamEvent | AssistantMessage | SystemAPIErrorMessage, void> {
  const { messages, systemPrompt, tools, signal } = params

  // Extract last user message for logging
  const lastUserMsg = [...messages].reverse().find(m => m.type === 'user')
  const userQuery = lastUserMsg?.type === 'user' 
    ? (typeof lastUserMsg.message?.content === 'string' 
        ? lastUserMsg.message.content.substring(0, 80) 
        : '[complex content]')
    : '[no user message]'

  routerLog(`\n${'='.repeat(60)}`, 'info')
  routerLog(`NEW QUERY: "${userQuery}"`, 'info')
  routerLog(`Tools available: ${tools?.length || 0}`, 'debug')
  if (tools && tools.length > 0) {
    const toolNames = tools.slice(0, 5).map(t => t.name).join(', ')
    routerLog(`First 5 tools: ${toolNames}${tools.length > 5 ? '...' : ''}`, 'debug')
  }

  // ── RAG: retrieve similar high-quality examples ─────────
  const fullUserQuery = lastUserMsg?.type === 'user'
    ? (typeof lastUserMsg.message?.content === 'string'
        ? lastUserMsg.message.content
        : '[complex content]')
    : ''
  const ragExamples = await retrieveSimilarExamples(fullUserQuery)
  const ragContext = formatRAGContext(ragExamples)
  if (ragExamples.length > 0) {
    routerLog(`📚 RAG: retrieved ${ragExamples.length} similar examples (quality: ${ragExamples.map(e => e.quality.toFixed(2)).join(', ')})`, 'info')
  }

  // Augment system prompt with RAG context if available
  const augmentedParams = ragContext
    ? { ...params, _ragContext: ragContext }
    : params

  // Track start time for latency measurement
  const routingStartTime = Date.now()

  // Get routing decision (async - may call orchestrator)
  let decision = await getRoutingDecisionAsync(messages, tools, config)

  // Log routing decision prominently
  const routeEmoji = decision.useLocal ? '🏠' : '☁️'
  const routeTarget = decision.useLocal ? `LOCAL (${decision.model})` : 'CLAUDE'
  routerLog(`${routeEmoji} ROUTING → ${routeTarget}`, decision.useLocal ? 'success' : 'warn')
  routerLog(`   Reason: ${decision.reason}`, 'debug')
  if (decision.suggestedTool) {
    routerLog(`   Suggested tool: ${decision.suggestedTool}`, 'info')
  }

  // Handle escalation to Claude (with fallback to local+tools if Claude fails)
  if (!decision.useLocal) {
    try {
      routerLog(`Escalating to Claude API...`, 'warn')
      const { queryModelWithStreaming } = await import('../api/claude.js')
      yield* queryModelWithStreaming(params as Parameters<typeof queryModelWithStreaming>[0])
      recordClaudeCall(0)
      routerLog(`Claude response complete`, 'success')
      return
    } catch (error) {
      routerLog(`Claude escalation failed: ${error}`, 'error')
      routerLog(`Falling back to local model with tools`, 'warn')
      // Fall through to local model with tools instead of failing
      decision = { ...decision, useLocal: true, model: config.localModel, action: 'local', reason: 'claude_fallback' }
    }
  }

  // Handle reasoning action - prepend reasoning step
  if (decision.action === 'reason') {
    routerLog(`Invoking reasoning model (DeepSeek-R1)...`, 'info')
    yield* handleReasoningAction(augmentedParams, decision, config)
    return
  }

  // Handle local action
  routerLog(`Calling local model: ${decision.model}`, 'info')
  yield* handleLocalAction(augmentedParams, decision, config)
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
    
    yield createAssistantMessage(content, 'deepseek-r1:7b', reasoningResult.usage, {
      routingDecision: 'reason',
      routingConfidence: decision.confidence,
      latencyMs: reasoningResult.durationMs,
    })
    recordLocalCall(reasoningResult.usage.inputTokens + reasoningResult.usage.outputTokens)

    // Capture reasoning path for training
    if (isCaptureEnabled()) {
      captureMultiTurn({
        userQuery: userContent,
        systemPrompt: '',
        toolCalls: [],
        toolResults: [],
        finalAnswer: reasoningText,
        tags: ['reasoning', 'deepseek-r1'],
        context: {
          sessionId: (params.options as any)?.sessionId || `session-${Date.now()}`,
          model: 'deepseek-r1:7b',
          routingDecision: 'reason',
          routingConfidence: decision.confidence ?? 0.7,
          routingReason: decision.reason,
          suggestedTool: decision.suggestedTool,
          inputTokens: reasoningResult.usage.inputTokens,
          outputTokens: reasoningResult.usage.outputTokens,
          latencyMs: reasoningResult.durationMs,
        },
      }).catch(e => routerLog(`Training capture error (reasoning): ${e}`, 'error'))
    }

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

  // Extract user query for capture (mirrors extraction in queryModelWithRouting)
  const lastUserMsg = [...messages].reverse().find(m => m.type === 'user')
  const fullUserQuery = lastUserMsg?.type === 'user'
    ? (typeof lastUserMsg.message?.content === 'string'
        ? lastUserMsg.message.content
        : '[complex content]')
    : ''

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
    const llmTools = await convertToolsToLLM(tools)

    routerLog(`handleLocalAction: model=${decision.model}, tools=${llmTools?.length || 0}`)
    if (llmTools && llmTools.length > 0) {
      // Log first 3 tool schemas to verify format
      for (const t of llmTools.slice(0, 3) as any[]) {
        routerLog(`  Tool: ${t.name} - desc length: ${t.description?.length || 0} - props: ${JSON.stringify(Object.keys(t.input_schema?.properties || {}))}`)
      }
    }

    // Use compact local system prompt instead of the full 29KB Claude prompt.
    // Check for LOCAL_SYSTEM_PROMPT env var (set by research/agent modes),
    // then canopy cache file, then built-in fallback.
    let systemPromptText: string
    const envPrompt = process.env.LOCAL_SYSTEM_PROMPT
    if (envPrompt && envPrompt.length > 50) {
      systemPromptText = envPrompt
      routerLog(`Using LOCAL_SYSTEM_PROMPT env override for local model (${envPrompt.length} chars)`)
    } else {
      systemPromptText = getLocalSystemPrompt()
      routerLog(`SystemPrompt for local model: length=${systemPromptText.length} (canopy-managed)`)
    }

    // Append RAG context from past high-quality examples if available
    const ragCtx = (params as any)?._ragContext as string | undefined
    if (ragCtx) {
      systemPromptText += ragCtx
      routerLog(`SystemPrompt augmented with RAG context (+${ragCtx.length} chars)`)
    }

    // If the orchestrator suggested a tool, hint the model to use it
    if (decision.suggestedTool) {
      // In coordinator mode, the model only has Agent + TaskStop.
      // Rewrite the hint to delegate via Agent instead of calling the tool directly.
      const isCoordinator = isEnvTruthy(process.env.CLAUDE_CODE_COORDINATOR_MODE)
      if (isCoordinator) {
        systemPromptText += `\n\nIMPORTANT: For this query, you MUST use the "Agent" tool to delegate the task to a worker agent. The worker has access to "${decision.suggestedTool}" and other tools. Create a detailed prompt describing what the worker should do. Do NOT answer from memory — delegate via Agent first.`
      } else {
        systemPromptText += `\n\nIMPORTANT: For this query, you should use the "${decision.suggestedTool}" tool. Do NOT answer from memory — invoke the tool first.`
      }
      routerLog(`Added suggestedTool hint for: ${decision.suggestedTool}`)
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

    // ── Tool Loop Detection ──────────────────────────────────────────────
    // Scan the last N assistant messages for consecutive calls to the same tool.
    // If the model called the same tool 3+ times in a row, remove it from the
    // tool list so the model is forced to synthesize an answer.
    const LOOP_THRESHOLD = 2
    let loopedToolName: string | null = null
    let consecutiveCount = 0
    let lastToolName: string | null = null

    // Walk assistant messages in reverse order
    for (let i = messages.length - 1; i >= 0; i--) {
      const m = messages[i]
      if (m.type !== 'assistant') continue
      const toolUses = m.message.content.filter((c: any) => c.type === 'tool_use')
      if (toolUses.length !== 1) break // Only track single-tool turns
      const name = (toolUses[0] as any).name
      if (lastToolName === null) {
        lastToolName = name
        consecutiveCount = 1
      } else if (name === lastToolName) {
        consecutiveCount++
      } else {
        break
      }
    }

    if (consecutiveCount >= LOOP_THRESHOLD && lastToolName) {
      loopedToolName = lastToolName
      routerLog(`🔄 TOOL LOOP DETECTED: "${loopedToolName}" called ${consecutiveCount} times consecutively`, 'warn')
    }

    // If looping, remove that tool and tell the model to answer
    let effectiveTools = llmTools
    let toolResultPreview = '' // Hoisted for capture block access
    if (loopedToolName && llmTools) {
      effectiveTools = llmTools.filter((t: any) => {
        const name = t.name || t.function?.name
        return name !== loopedToolName
      })
      routerLog(`Removed looped tool "${loopedToolName}" from tool list (${llmTools.length} → ${effectiveTools.length})`, 'warn')
      
      // Extract the most recent tool result for this tool to help the model answer
      for (let i = messages.length - 1; i >= 0; i--) {
        const m = messages[i]
        if (m.type !== 'user') continue
        const content = (m as any).message?.content
        if (!Array.isArray(content)) continue
        for (const c of content) {
          if (c.type === 'tool_result') {
            const resultText = typeof c.content === 'string' ? c.content : JSON.stringify(c.content)
            if (resultText.length > 100) {
              toolResultPreview = resultText.substring(0, 3000)
              break
            }
          }
        }
        if (toolResultPreview) break
      }
      
      systemPromptText += `\n\n⚠️ IMPORTANT: You have already called "${loopedToolName}" ${consecutiveCount} times and received its results. Do NOT attempt to call it again or any other tool. You MUST now answer the user's original question using the data below. Provide a clear, concise summary.\n\nData from ${loopedToolName}:\n${toolResultPreview}`
    }

    // Stream from local model
    routerLog(`[STREAM] Starting stream from ${decision.model}...`, 'info')
    streamEventCount = 0 // Reset counter for new stream
    const localStartTime = Date.now()
    
    const stream = provider.stream({
      model: decision.model,
      messages: llmMessages,
      systemPrompt: systemPromptText,
      tools: effectiveTools,
      maxTokens: 4096,
    })

    let accumulatedContent: MessageContent[] = []
    let accumulatedText = ''
    let usage = { inputTokens: 0, outputTokens: 0 }
    let yieldsCount = 0

    for await (const event of stream) {
      // Check abort
      if (signal.aborted) {
        throw new Error('Request aborted')
      }

      // Convert and yield stream events
      const streamEvent = convertToStreamEvent(event, decision.model)
      if (streamEvent) {
        yieldsCount++
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

    // Log response summary prominently
    routerLog(`\n📤 MODEL RESPONSE:`, 'success')
    const toolUses = accumulatedContent.filter(c => c.type === 'tool_use')
    const textBlocks = accumulatedContent.filter(c => c.type === 'text')
    
    if (toolUses.length > 0) {
      routerLog(`   🔧 TOOL CALLS: ${toolUses.length}`, 'success')
      for (const c of toolUses) {
        if (c.type === 'tool_use') {
          const inputPreview = JSON.stringify(c.input).substring(0, 100)
          routerLog(`      → ${c.name}(${inputPreview}...)`, 'info')
        }
      }
    }
    
    if (textBlocks.length > 0) {
      for (const c of textBlocks) {
        if (c.type === 'text' && c.text) {
          const preview = c.text.substring(0, 150).replace(/\n/g, ' ')
          routerLog(`   💬 TEXT: "${preview}${c.text.length > 150 ? '...' : ''}"`, 'info')
        }
      }
    }
    
    if (toolUses.length === 0 && textBlocks.length > 0) {
      routerLog(`   ⚠️  Model responded with text only (no tool calls)`, 'warn')
    }
    
    routerLog(`   Tokens: ${usage.inputTokens} in / ${usage.outputTokens} out`, 'debug')
    routerLog(`[STREAM] Total stream events yielded: ${yieldsCount}`, 'info')

    // Yield final assistant message
    routerLog(`[STREAM] Yielding final AssistantMessage`, 'success')
    yield createAssistantMessage(accumulatedContent, decision.model, usage, {
      routingDecision: decision.action as 'local' | 'reason' | 'escalate',
      routingConfidence: decision.confidence,
      latencyMs: Date.now() - localStartTime,
    })
    recordLocalCall(usage.inputTokens + usage.outputTokens)

    // ── Training Capture ───────────────────────────────────────────────────
    // Capture successful tool use or tool loop recovery for training data
    routerLog(`[CAPTURE] isCaptureEnabled=${isCaptureEnabled()}, toolUses=${toolUses.length}, messagesLen=${messages.length}`)
    if (isCaptureEnabled()) {
      const finalText = textBlocks.map(b => b.type === 'text' ? b.text : '').join('')

      // Extract tool calls + results from full conversation history
      // (toolUses only has current turn's calls, which is empty on the answer turn)
      const historyToolCalls: Array<{ name: string; arguments: string; result: string }> = []
      const toolResultMap = new Map<string, string>()

      // First pass: collect all tool_result blocks keyed by tool_use_id
      for (const m of messages) {
        if (m.type === 'user' && Array.isArray(m.message.content)) {
          for (const c of m.message.content) {
            if (c.type === 'tool_result') {
              const id = (c as any).tool_use_id
              const content = typeof c.content === 'string'
                ? c.content
                : JSON.stringify(c.content)
              toolResultMap.set(id, content)
            }
          }
        }
      }

      // Second pass: collect all tool_use blocks from assistant turns, match with results
      for (const m of messages) {
        if (m.type === 'assistant') {
          for (const c of m.message.content) {
            if (c.type === 'tool_use') {
              const tu = c as any
              historyToolCalls.push({
                name: tu.name,
                arguments: JSON.stringify(tu.input),
                result: toolResultMap.get(tu.id) || '',
              })
            }
          }
        }
      }

      routerLog(`[CAPTURE] historyToolCalls=${historyToolCalls.length}, finalTextLen=${finalText.length}, loopedTool=${loopedToolName || 'none'}`)
      if (historyToolCalls.length > 0) {
        routerLog(`[CAPTURE] Tool names: ${historyToolCalls.map(t => t.name).join(', ')}`)
        routerLog(`[CAPTURE] Results present: ${historyToolCalls.map(t => t.result.length > 0).join(', ')}`)
      }

      // Research capture: scan MCP tool results for structured research responses
      if (isResearchCaptureEnabled() && toolResultMap.size > 0) {
        routerLog(`[RESEARCH_CAPTURE] toolResultMap.size=${toolResultMap.size}`)
        for (const [id, content] of toolResultMap) {
          const toolName = historyToolCalls.find(t => t.result === content)?.name || 'unknown'
          routerLog(`[RESEARCH_CAPTURE] tool=${toolName}, id=${id}, contentLen=${content.length}, preview=${content.substring(0, 200).replace(/\n/g, '\\n')}`)
        }
        captureResearchFindings(
          toolResultMap,
          historyToolCalls,
          fullUserQuery,
          {
            sessionId: (params.options as any)?.sessionId || `session-${Date.now()}`,
            model: decision.model,
            routingDecision: decision.action,
          },
        ).catch(e => routerLog(`Research capture error: ${e}`, 'error'))
      }

      if (loopedToolName && finalText.length > 50) {
        // Tool loop recovery: model was stuck, now answered - capture as DPO + positive
        captureToolLoopRecovery({
          userQuery: fullUserQuery,
          systemPrompt: systemPromptText.substring(0, 3000),
          loopedToolName,
          toolCallCount: consecutiveCount,
          toolResult: toolResultPreview,
          finalAnswer: finalText,
          context: {
            sessionId: (params.options as any)?.sessionId || `session-${Date.now()}`,
            model: decision.model,
            routingDecision: decision.action,
            routingConfidence: decision.confidence ?? 0.7,
            routingReason: decision.reason,
            suggestedTool: decision.suggestedTool,
            inputTokens: usage.inputTokens,
            outputTokens: usage.outputTokens,
            latencyMs: Date.now() - localStartTime,
          },
        }).catch(e => routerLog(`Training capture error: ${e}`, 'error'))
      } else if (historyToolCalls.length > 0 && finalText.length > 50) {
        // Successful tool use: capture as positive example
        captureSuccessfulToolUse({
          userQuery: fullUserQuery,
          systemPrompt: systemPromptText.substring(0, 3000),
          toolCalls: historyToolCalls,
          finalAnswer: finalText,
          context: {
            sessionId: (params.options as any)?.sessionId || `session-${Date.now()}`,
            model: decision.model,
            routingDecision: decision.action,
            routingConfidence: decision.confidence ?? 0.7,
            routingReason: decision.reason,
            suggestedTool: decision.suggestedTool,
            inputTokens: usage.inputTokens,
            outputTokens: usage.outputTokens,
            latencyMs: Date.now() - localStartTime,
          },
        }).catch(e => routerLog(`Training capture error: ${e}`, 'error'))
      }
    }

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
