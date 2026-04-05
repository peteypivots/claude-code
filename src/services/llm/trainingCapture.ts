/**
 * trainingCapture.ts — Centralized Real-Time Training Data Capture
 *
 * Captures high-quality training examples from live interactions:
 * - Multi-turn conversations with tool calls
 * - DPO pairs (preferred vs rejected responses)
 * - Tool loop recoveries (model learned to answer after being stuck)
 *
 * This centralizes capture logic so individual agents/components don't
 * need their own implementations. Just call the capture functions.
 *
 * Environment:
 *   LANCEDB_URI           — LanceDB REST API (default: http://lancedb-api:8000)
 *   OLLAMA_BASE_URL       — Ollama for embeddings (default: http://ollama:11434)
 *   EMBEDDING_MODEL       — Embedding model (default: nomic-embed-text)
 *   TRAINING_CAPTURE      — Enable capture: 'true' (default: false)
 *   TRAINING_CAPTURE_VERBOSE — Log capture events (default: false)
 */

import { createHash, randomUUID } from 'crypto'

// ── Config ────────────────────────────────────────────────────────────────────
const LANCEDB_URI = process.env.LANCEDB_URI || 'http://lancedb-api:8000'
const OLLAMA_BASE_URL = process.env.OLLAMA_BASE_URL || 'http://ollama:11434'
const EMBEDDING_MODEL = process.env.EMBEDDING_MODEL || 'nomic-embed-text'
const DB = 'user_dbs'
const TABLE = 'training_examples'

const CAPTURE_ENABLED = process.env.TRAINING_CAPTURE === 'true'
const VERBOSE = process.env.TRAINING_CAPTURE_VERBOSE === 'true'

// Fields that exist in the LanceDB training_examples table schema.
// Records are filtered to only include these fields before ingest to avoid
// "field does not exist" errors when the code adds new fields.
const TABLE_SCHEMA_FIELDS = new Set([
  'id', 'session_id', 'system_prompt', 'user_content', 'assistant_content',
  'canonical_prompt', 'model_used', 'routing_decision', 'routing_confidence',
  'routing_reason', 'suggested_tool', 'input_tokens', 'output_tokens',
  'latency_ms', 'feedback', 'quality_score', 'tags', 'content_hash',
  'turn_index', 'timestamp', 'embedding',
])

// ── Types ─────────────────────────────────────────────────────────────────────

export interface ToolCall {
  id: string
  name: string
  arguments: string | Record<string, unknown>
}

export interface ToolResult {
  toolCallId: string
  content: string
  isError?: boolean
}

export interface Message {
  role: 'system' | 'user' | 'assistant' | 'tool'
  content?: string | null
  tool_calls?: Array<{ id: string; name: string; arguments: string }>
  tool_call_id?: string
}

export interface CaptureContext {
  sessionId?: string
  model?: string
  routingDecision?: 'local' | 'reason' | 'escalate' | string
  routingConfidence?: number
  routingReason?: string
  suggestedTool?: string
  inputTokens?: number
  outputTokens?: number
  latencyMs?: number
}

export interface MultiTurnCapture {
  /** System prompt used */
  systemPrompt?: string
  /** User's query */
  userQuery: string
  /** Tool calls made by assistant */
  toolCalls: Array<{ name: string; arguments: string }>
  /** Tool results received */
  toolResults: Array<{ name: string; content: string; isError?: boolean }>
  /** Final assistant answer */
  finalAnswer: string
  /** Tags for filtering */
  tags?: string[]
  /** Additional context */
  context?: CaptureContext
}

export interface DPOCapture {
  /** User's query */
  userQuery: string
  /** System prompt used */
  systemPrompt?: string
  /** Correct response (chosen) */
  chosenResponse: {
    toolCalls?: Array<{ name: string; arguments: string }>
    content?: string
  }
  /** Incorrect response (rejected) - e.g., text-only when tool was needed */
  rejectedResponse: {
    content: string
  }
  /** Tags for filtering */
  tags?: string[]
  /** Additional context */
  context?: CaptureContext
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function log(msg: string, level: 'info' | 'warn' | 'error' = 'info') {
  if (!VERBOSE && level === 'info') return
  const prefix = level === 'error' ? '❌' : level === 'warn' ? '⚠️' : '📝'
  console.log(`[TrainingCapture] ${prefix} ${msg}`)
}

function contentHash(text: string): string {
  return createHash('sha256').update(text.toLowerCase()).digest('hex').substring(0, 16)
}

function genToolId(): string {
  return `tc_${randomUUID().substring(0, 8)}`
}

async function getEmbedding(text: string): Promise<number[] | null> {
  try {
    const res = await fetch(`${OLLAMA_BASE_URL}/api/embed`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: EMBEDDING_MODEL, input: text.substring(0, 2000) }),
      signal: AbortSignal.timeout(10000),
    })
    if (!res.ok) return null
    const data = (await res.json()) as { embeddings?: number[][] }
    return data.embeddings?.[0] ?? null
  } catch {
    return null
  }
}

function computeQualityScore(context?: CaptureContext, toolSuccess?: boolean): number {
  const routingConf = context?.routingConfidence ?? 0.7
  const toolScore = toolSuccess !== undefined ? (toolSuccess ? 1.0 : 0.3) : 0.7
  return 0.5 * routingConf + 0.5 * toolScore
}

function autoTag(capture: MultiTurnCapture | DPOCapture): string[] {
  const tags: string[] = []
  if ('toolCalls' in capture && capture.toolCalls.length > 0) {
    tags.push('tool_use')
    if (capture.toolCalls.length > 1) tags.push('multi_tool')
  }
  if ('chosenResponse' in capture) {
    tags.push('dpo')
    if (capture.chosenResponse.toolCalls?.length) tags.push('tool_use_correction')
  }
  if (capture.context?.routingDecision === 'reason') tags.push('reasoning')
  if (capture.context?.routingDecision === 'escalate') tags.push('escalated')
  if (capture.tags) tags.push(...capture.tags)
  return [...new Set(tags)]
}

// ── Message Builders (OpenAI Chat Format) ─────────────────────────────────────

function buildMessagesArray(capture: MultiTurnCapture): Message[] {
  const messages: Message[] = []

  // System
  if (capture.systemPrompt) {
    messages.push({ role: 'system', content: capture.systemPrompt })
  }

  // User
  messages.push({ role: 'user', content: capture.userQuery })

  // Assistant with tool_calls
  if (capture.toolCalls.length > 0) {
    const toolCallsFormatted = capture.toolCalls.map((tc) => ({
      id: genToolId(),
      name: tc.name,
      arguments: typeof tc.arguments === 'string' ? tc.arguments : JSON.stringify(tc.arguments),
    }))

    messages.push({
      role: 'assistant',
      content: null,
      tool_calls: toolCallsFormatted,
    })

    // Tool results
    for (let i = 0; i < capture.toolResults.length; i++) {
      const result = capture.toolResults[i]
      const callId = toolCallsFormatted[i]?.id || genToolId()
      messages.push({
        role: 'tool',
        tool_call_id: callId,
        content: result.content.substring(0, 5000),
      })
    }
  }

  // Final assistant answer
  messages.push({ role: 'assistant', content: capture.finalAnswer })

  return messages
}

function buildDPOObject(capture: DPOCapture): { prompt: Message[]; chosen: Message[]; rejected: Message[] } {
  const prompt: Message[] = []

  if (capture.systemPrompt) {
    prompt.push({ role: 'system', content: capture.systemPrompt })
  }
  prompt.push({ role: 'user', content: capture.userQuery })

  // Chosen: correct response (usually with tool calls)
  const chosen: Message[] = []
  if (capture.chosenResponse.toolCalls?.length) {
    const toolCalls = capture.chosenResponse.toolCalls.map(tc => ({
      id: genToolId(),
      name: tc.name,
      arguments: typeof tc.arguments === 'string' ? tc.arguments : JSON.stringify(tc.arguments),
    }))
    chosen.push({
      role: 'assistant',
      content: capture.chosenResponse.content || null,
      tool_calls: toolCalls,
    })
  } else if (capture.chosenResponse.content) {
    chosen.push({ role: 'assistant', content: capture.chosenResponse.content })
  }

  // Rejected: incorrect response (usually text-only when tool was needed)
  const rejected: Message[] = [{ role: 'assistant', content: capture.rejectedResponse.content }]

  return { prompt, chosen, rejected }
}

// ── LanceDB Ingest ────────────────────────────────────────────────────────────

async function ingest(record: Record<string, unknown>): Promise<boolean> {
  if (!CAPTURE_ENABLED) {
    log('Capture disabled (TRAINING_CAPTURE != true)', 'info')
    return false
  }

  // Filter record to only include fields in the table schema
  const filtered: Record<string, unknown> = {}
  for (const key of Object.keys(record)) {
    if (TABLE_SCHEMA_FIELDS.has(key)) {
      filtered[key] = record[key]
    }
  }

  try {
    const res = await fetch(`${LANCEDB_URI}/dbs/${DB}/tables/${TABLE}/ingest`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ records: [filtered] }),
      signal: AbortSignal.timeout(10000),
    })

    if (res.ok) {
      log(`Stored: ${filtered.id} (${filtered.tags})`)
      // Also log to router debug file for visibility
      try {
        const { appendFileSync } = require('fs')
        appendFileSync('/tmp/router-debug.log', `[${new Date().toISOString()}] [CAPTURE] Stored: ${filtered.id} (${filtered.tags})\n`)
      } catch {}
      return true
    } else {
      const body = await res.text()
      log(`Ingest failed: ${res.status} - ${body.substring(0, 200)}`, 'error')
      try {
        const { appendFileSync } = require('fs')
        appendFileSync('/tmp/router-debug.log', `[${new Date().toISOString()}] [CAPTURE] Ingest failed: ${res.status} - ${body.substring(0, 200)}\n`)
      } catch {}
      return false
    }
  } catch (e) {
    log(`Ingest error: ${e}`, 'error')
    try {
      const { appendFileSync } = require('fs')
      appendFileSync('/tmp/router-debug.log', `[${new Date().toISOString()}] [CAPTURE] Ingest error: ${e}\n`)
    } catch {}
    return false
  }
}

// ── Public Capture Functions ──────────────────────────────────────────────────

/**
 * Capture a multi-turn conversation with tool usage.
 * This is the primary format for training - teaches the model the full
 * conversation flow: query → tool call → result → synthesis.
 */
export async function captureMultiTurn(capture: MultiTurnCapture): Promise<string | null> {
  if (!CAPTURE_ENABLED) return null

  const id = randomUUID()
  const timestamp = new Date().toISOString()
  const tags = autoTag(capture)
  const hash = contentHash(capture.userQuery + capture.finalAnswer)

  // Build messages array
  const messages = buildMessagesArray(capture)

  // Compute quality score
  const toolSuccess = capture.toolResults.every(r => !r.isError)
  const qualityScore = computeQualityScore(capture.context, toolSuccess)

  // Generate embedding for retrieval
  const embeddingText = `${capture.userQuery}\n${capture.finalAnswer}`.substring(0, 2000)
  const embedding = await getEmbedding(embeddingText)

  // Build record using ETL-compatible schema
  const record: Record<string, unknown> = {
    id,
    session_id: capture.context?.sessionId || `capture-${Date.now()}`,
    system_prompt: (capture.systemPrompt || '').substring(0, 5000),
    user_content: capture.userQuery.substring(0, 10000),
    assistant_content: capture.finalAnswer.substring(0, 10000),
    // Store full multi-turn messages in canonical_prompt (v7 format)
    canonical_prompt: JSON.stringify(messages),
    model_used: capture.context?.model || 'unknown',
    routing_decision: capture.context?.routingDecision || 'local',
    routing_confidence: capture.context?.routingConfidence ?? 0.7,
    routing_reason: capture.context?.routingReason || null,
    suggested_tool: capture.context?.suggestedTool || null,
    input_tokens: capture.context?.inputTokens ?? 0,
    output_tokens: capture.context?.outputTokens ?? 0,
    latency_ms: capture.context?.latencyMs ?? 0,
    feedback: null,
    quality_score: qualityScore,
    tags: ['v7_multi_turn', ...tags].join(','),
    content_hash: hash,
    turn_index: 0,
    timestamp,
  }

  // Add embedding if available
  if (embedding) {
    record.embedding = embedding
  }

  const success = await ingest(record)
  captureStats.multiTurn++
  return success ? id : null
}

/**
 * Capture a DPO (Direct Preference Optimization) pair.
 * Used when the model gave a bad response and we have the correct one.
 * Teaches the model to prefer tool calls over text hallucination.
 */
export async function captureDPO(capture: DPOCapture): Promise<string | null> {
  if (!CAPTURE_ENABLED) return null

  const id = randomUUID()
  const timestamp = new Date().toISOString()
  const tags = autoTag(capture)
  const hash = contentHash(capture.userQuery + capture.rejectedResponse.content)

  // Build DPO object
  const dpo = buildDPOObject(capture)

  // Generate embedding
  const embeddingText = capture.userQuery.substring(0, 2000)
  const embedding = await getEmbedding(embeddingText)

  // Build record using ETL-compatible schema
  const record: Record<string, unknown> = {
    id,
    session_id: capture.context?.sessionId || `capture-${Date.now()}`,
    system_prompt: (capture.systemPrompt || '').substring(0, 5000),
    user_content: capture.userQuery.substring(0, 10000),
    assistant_content: capture.rejectedResponse.content.substring(0, 10000),
    // Store DPO object in canonical_prompt (v7 format)
    canonical_prompt: JSON.stringify(dpo),
    model_used: capture.context?.model || 'unknown',
    routing_decision: capture.context?.routingDecision || 'local',
    routing_confidence: capture.context?.routingConfidence ?? 0.5,
    routing_reason: capture.context?.routingReason || null,
    suggested_tool: capture.context?.suggestedTool || null,
    input_tokens: capture.context?.inputTokens ?? 0,
    output_tokens: capture.context?.outputTokens ?? 0,
    latency_ms: capture.context?.latencyMs ?? 0,
    feedback: 'down', // DPO rejected = implicit negative feedback
    quality_score: 0.3, // Low score for correction examples
    tags: ['v7_dpo', ...tags].join(','),
    content_hash: hash,
    turn_index: 0,
    timestamp,
  }

  if (embedding) {
    record.embedding = embedding
  }

  const success = await ingest(record)
  captureStats.dpo++
  return success ? id : null
}

/**
 * Capture a tool loop recovery example.
 * When the model gets stuck calling the same tool repeatedly and we
 * force it to answer, capture as both a DPO pair and a positive example.
 */
export async function captureToolLoopRecovery(params: {
  userQuery: string
  systemPrompt?: string
  loopedToolName: string
  toolCallCount: number
  toolResult: string
  finalAnswer: string
  context?: CaptureContext
}): Promise<{ dpoId: string | null; multiTurnId: string | null }> {
  const result = { dpoId: null as string | null, multiTurnId: null as string | null }
  if (!CAPTURE_ENABLED) return result

  // 1. Capture as DPO: "don't keep calling the same tool"
  result.dpoId = await captureDPO({
    userQuery: params.userQuery,
    systemPrompt: params.systemPrompt,
    chosenResponse: {
      // After getting tool result once, synthesize answer
      content: params.finalAnswer,
    },
    rejectedResponse: {
      // Wrong: calling the same tool again
      content: `I'll call ${params.loopedToolName} again to get more information.`,
    },
    tags: ['tool_loop_recovery', `looped_${params.loopedToolName}`],
    context: params.context,
  })

  // 2. Capture the correct flow as multi-turn
  result.multiTurnId = await captureMultiTurn({
    userQuery: params.userQuery,
    systemPrompt: params.systemPrompt,
    toolCalls: [{ name: params.loopedToolName, arguments: '{}' }],
    toolResults: [{ name: params.loopedToolName, content: params.toolResult }],
    finalAnswer: params.finalAnswer,
    tags: ['tool_loop_recovery', 'synthetic'],
    context: params.context,
  })

  captureStats.toolLoop++
  return result
}

/**
 * Capture a fallback recovery example.
 * When the model fails and we run a fallback (e.g., direct pipeline execution),
 * capture the correct flow.
 */
export async function captureFallbackRecovery(params: {
  userQuery: string
  systemPrompt?: string
  badResponse: string
  correctToolCall: { name: string; arguments: string }
  toolResult: string
  synthesizedAnswer: string
  context?: CaptureContext
}): Promise<{ dpoId: string | null; multiTurnId: string | null }> {
  const result = { dpoId: null as string | null, multiTurnId: null as string | null }
  if (!CAPTURE_ENABLED) return result

  // 1. DPO: prefer tool call over text-only response
  result.dpoId = await captureDPO({
    userQuery: params.userQuery,
    systemPrompt: params.systemPrompt,
    chosenResponse: {
      toolCalls: [params.correctToolCall],
    },
    rejectedResponse: {
      content: params.badResponse,
    },
    tags: ['fallback_recovery', 'tool_use_correction'],
    context: params.context,
  })

  // 2. Multi-turn: the correct conversation flow
  result.multiTurnId = await captureMultiTurn({
    userQuery: params.userQuery,
    systemPrompt: params.systemPrompt,
    toolCalls: [params.correctToolCall],
    toolResults: [{ name: params.correctToolCall.name, content: params.toolResult }],
    finalAnswer: params.synthesizedAnswer,
    tags: ['fallback_recovery', 'synthetic'],
    context: params.context,
  })

  captureStats.fallback++
  return result
}

/**
 * Capture a successful tool use (positive example).
 * Call this after a successful tool-assisted response.
 */
export async function captureSuccessfulToolUse(params: {
  userQuery: string
  systemPrompt?: string
  toolCalls: Array<{ name: string; arguments: string; result: string; isError?: boolean }>
  finalAnswer: string
  context?: CaptureContext
}): Promise<string | null> {
  if (!CAPTURE_ENABLED) return null

  return captureMultiTurn({
    userQuery: params.userQuery,
    systemPrompt: params.systemPrompt,
    toolCalls: params.toolCalls.map(tc => ({ name: tc.name, arguments: tc.arguments })),
    toolResults: params.toolCalls.map(tc => ({ name: tc.name, content: tc.result, isError: tc.isError })),
    finalAnswer: params.finalAnswer,
    tags: ['positive', 'tool_use_success'],
    context: params.context,
  })
}

// ── External API Capture (Grok, etc) ──────────────────────────────────────────

export interface ExternalAPICapture {
  /** API provider (grok, perplexity, etc) */
  provider: string
  /** API endpoint/method called */
  endpoint: string
  /** Original request/query */
  request: string
  /** API response */
  response: string
  /** Latency in milliseconds */
  latencyMs: number
  /** Whether call was rate limited */
  rateLimited?: boolean
  /** Rate limit state at time of call */
  rateLimitState?: {
    totalCalls: number
    rateLimitHits: number
    estimatedResetSecs?: number
  }
  /** Tags for filtering */
  tags?: string[]
}

export interface QueryRephraseCapture {
  /** Original query that hit duplicates */
  originalQuery: string
  /** Alternative suggested by Grok */
  alternativeQuery: string
  /** Context: why rephrase was needed */
  reason: 'duplicate_results' | 'no_results' | 'low_quality' | string
  /** Number of duplicates that triggered rephrase */
  duplicateCount?: number
  /** Whether the alternative worked better */
  alternativeSuccess?: boolean
}

/**
 * Capture an external API interaction (Grok, etc).
 * Useful for tracking API usage, rate limits, and training query routing.
 */
export async function captureExternalAPICall(capture: ExternalAPICapture): Promise<string | null> {
  if (!CAPTURE_ENABLED) return null

  const id = randomUUID()
  const timestamp = new Date().toISOString()
  const tags = ['external_api', capture.provider, ...(capture.tags || [])]
  const hash = contentHash(capture.request + capture.response)

  // Generate embedding
  const embeddingText = `${capture.request}\n${capture.response}`.substring(0, 2000)
  const embedding = await getEmbedding(embeddingText)

  // Build record
  const record: Record<string, unknown> = {
    id,
    session_id: `external-api-${Date.now()}`,
    system_prompt: `External API: ${capture.provider} - ${capture.endpoint}`,
    user_content: capture.request.substring(0, 10000),
    assistant_content: capture.response.substring(0, 10000),
    canonical_prompt: JSON.stringify({
      type: 'external_api',
      provider: capture.provider,
      endpoint: capture.endpoint,
      request: capture.request,
      response: capture.response,
      rateLimited: capture.rateLimited,
      rateLimitState: capture.rateLimitState,
    }),
    model_used: capture.provider,
    routing_decision: 'external',
    routing_confidence: capture.rateLimited ? 0.0 : 1.0,
    latency_ms: capture.latencyMs,
    feedback: capture.rateLimited ? 'down' : null,
    quality_score: capture.rateLimited ? 0.0 : 0.8,
    tags: tags.join(','),
    content_hash: hash,
    turn_index: 0,
    timestamp,
  }

  if (embedding) {
    record.embedding = embedding
  }

  const success = await ingest(record)
  captureStats.externalAPI++
  return success ? id : null
}

/**
 * Capture a query rephrase example (Grok suggested alternative).
 * Useful for training query expansion/refinement models.
 */
export async function captureQueryRephrase(capture: QueryRephraseCapture): Promise<string | null> {
  if (!CAPTURE_ENABLED) return null

  const id = randomUUID()
  const timestamp = new Date().toISOString()
  const tags = ['query_rephrase', `reason_${capture.reason}`]
  if (capture.alternativeSuccess) tags.push('rephrase_success')
  const hash = contentHash(capture.originalQuery + capture.alternativeQuery)

  // Generate embedding
  const embeddingText = `Original: ${capture.originalQuery}\nAlternative: ${capture.alternativeQuery}`
  const embedding = await getEmbedding(embeddingText)

  // Build record
  const record: Record<string, unknown> = {
    id,
    session_id: `rephrase-${Date.now()}`,
    system_prompt: 'Query rephrase training example',
    user_content: capture.originalQuery.substring(0, 10000),
    assistant_content: capture.alternativeQuery.substring(0, 10000),
    canonical_prompt: JSON.stringify({
      type: 'query_rephrase',
      original: capture.originalQuery,
      alternative: capture.alternativeQuery,
      reason: capture.reason,
      duplicateCount: capture.duplicateCount,
      alternativeSuccess: capture.alternativeSuccess,
    }),
    model_used: 'grok',
    routing_decision: 'external',
    routing_confidence: 0.9,
    latency_ms: 0,
    feedback: capture.alternativeSuccess ? 'up' : null,
    quality_score: capture.alternativeSuccess ? 0.9 : 0.5,
    tags: tags.join(','),
    content_hash: hash,
    turn_index: 0,
    timestamp,
  }

  if (embedding) {
    record.embedding = embedding
  }

  const success = await ingest(record)
  captureStats.rephrase++
  return success ? id : null
}

/**
 * Batch capture multiple query rephrase examples.
 * Used when Grok returns alternatives for multiple queries at once.
 */
export async function captureBatchRephrase(
  alternatives: Record<string, string>,
  reason: string = 'duplicate_results'
): Promise<string[]> {
  const ids: string[] = []
  
  for (const [original, alternative] of Object.entries(alternatives)) {
    const id = await captureQueryRephrase({
      originalQuery: original,
      alternativeQuery: alternative,
      reason,
    })
    if (id) ids.push(id)
  }
  
  return ids
}

// ── Stats & Debugging ─────────────────────────────────────────────────────────

let captureStats = {
  multiTurn: 0,
  dpo: 0,
  toolLoop: 0,
  fallback: 0,
  externalAPI: 0,
  rephrase: 0,
  errors: 0,
}

export function getCaptureStats() {
  return { ...captureStats }
}

export function resetCaptureStats() {
  captureStats = { multiTurn: 0, dpo: 0, toolLoop: 0, fallback: 0, externalAPI: 0, rephrase: 0, errors: 0 }
}

export function isCaptureEnabled(): boolean {
  return CAPTURE_ENABLED
}
