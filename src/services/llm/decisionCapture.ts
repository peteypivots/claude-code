/**
 * decisionCapture.ts — Unified Decision Event Tracking
 *
 * Captures ALL decision points in the AI pipeline for full observability:
 * - Routing decisions (local/reason/escalate)
 * - Memory file selection
 * - Query deduplication
 * - Tool suggestions
 * - Force-answer triggers
 *
 * Every decision is logged to LanceDB with:
 * - Input context (what triggered the decision)
 * - Outcome (what was decided)
 * - Reasoning (why)
 * - Alternatives (what else was considered)
 * - Scores (confidence, distances, latency)
 *
 * Environment:
 *   LANCEDB_URI              — LanceDB REST API (default: http://lancedb-api:8000)
 *   OLLAMA_BASE_URL          — Ollama for embeddings (default: http://ollama:11434)
 *   EMBEDDING_MODEL          — Embedding model (default: nomic-embed-text)
 *   DECISION_CAPTURE         — Enable capture: 'true' (default: true)
 *   DECISION_CAPTURE_VERBOSE — Log capture events (default: false)
 */

import { createHash, randomUUID } from 'crypto'
import { appendFileSync } from 'fs'

// ── Config ────────────────────────────────────────────────────────────────────
const LANCEDB_URI = process.env.LANCEDB_URI || 'http://lancedb-api:8000'
const OLLAMA_BASE_URL = process.env.OLLAMA_BASE_URL || 'http://ollama:11434'
const EMBEDDING_MODEL = process.env.EMBEDDING_MODEL || 'nomic-embed-text'
const DB = 'user_dbs'
const TABLE = 'decision_events'

// Default to enabled (opt-out rather than opt-in)
const CAPTURE_ENABLED = process.env.DECISION_CAPTURE !== 'false'
const VERBOSE = process.env.DECISION_CAPTURE_VERBOSE === 'true'
const LOG_FILE = process.env.OLLAMA_DEBUG_LOG_FILE || '/data/logs/router-debug.log'

// Fields that exist in the LanceDB decision_events table schema
const TABLE_SCHEMA_FIELDS = new Set([
  'id', 'session_id', 'timestamp', 'decision_type', 'decision_subtype',
  'input_summary', 'input_hash', 'outcome', 'reasoning', 'alternatives',
  'scores', 'latency_ms', 'embedding', 'tags',
])

// ── Types ─────────────────────────────────────────────────────────────────────

export type DecisionType = 
  | 'routing'        // local/reason/escalate
  | 'memory_select'  // which memory files to load
  | 'query_dedup'    // is query duplicate
  | 'tool_suggest'   // which tool to use
  | 'force_answer'   // force model to answer instead of loop
  | 'index_rebuild'  // memory/query index rebuilt
  | 'cache_hit'      // routing cache hit
  | 'escalation'     // escalation to Claude

export interface Alternative {
  option: string
  score?: number
  reason?: string
}

export interface DecisionScores {
  confidence?: number
  distance?: number
  latencyMs?: number
  tokenCount?: number
  resultCount?: number
  [key: string]: number | undefined
}

export interface DecisionEvent {
  /** Unique event ID */
  id?: string
  /** Session/conversation ID */
  sessionId?: string
  /** Event timestamp */
  timestamp?: number
  /** Type of decision */
  decisionType: DecisionType
  /** Subtype for more granular tracking */
  decisionSubtype?: string
  /** Summary of input that triggered decision */
  inputSummary: string
  /** Hash of input for dedup */
  inputHash?: string
  /** What was decided */
  outcome: string
  /** Why this decision was made */
  reasoning?: string
  /** Other options considered */
  alternatives?: Alternative[]
  /** Numeric scores/metrics */
  scores?: DecisionScores
  /** Latency in milliseconds */
  latencyMs?: number
  /** Tags for filtering */
  tags?: string[]
}

export interface DecisionCaptureContext {
  sessionId?: string
  model?: string
  turnIndex?: number
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function log(msg: string, level: 'info' | 'warn' | 'error' = 'info') {
  if (!VERBOSE && level === 'info') return
  const prefix = level === 'error' ? '❌' : level === 'warn' ? '⚠️' : '📊'
  console.error(`[DecisionCapture] ${prefix} ${msg}`)
}

function routerLog(msg: string) {
  try {
    appendFileSync(LOG_FILE, `[${new Date().toISOString()}] [DECISION] ${msg}\n`)
  } catch {}
}

function contentHash(text: string): string {
  return createHash('sha256').update(text.toLowerCase()).digest('hex').substring(0, 16)
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

// ── LanceDB Ingest ────────────────────────────────────────────────────────────

async function ingest(record: Record<string, unknown>): Promise<boolean> {
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
      log(`Stored: ${filtered.id} (${filtered.decision_type})`)
      routerLog(`Stored: ${filtered.id} type=${filtered.decision_type} outcome=${filtered.outcome}`)
      return true
    } else {
      const body = await res.text()
      log(`Ingest failed: ${res.status} - ${body.substring(0, 200)}`, 'error')
      routerLog(`Ingest failed: ${res.status}`)
      return false
    }
  } catch (e) {
    log(`Ingest error: ${e}`, 'error')
    routerLog(`Ingest error: ${e}`)
    return false
  }
}

// ── Public API ────────────────────────────────────────────────────────────────

export function isDecisionCaptureEnabled(): boolean {
  return CAPTURE_ENABLED
}

/**
 * Capture a decision event
 */
export async function captureDecision(event: DecisionEvent): Promise<void> {
  if (!CAPTURE_ENABLED) return

  const id = event.id || `dec_${randomUUID().substring(0, 12)}`
  const timestamp = event.timestamp || Date.now()
  const inputHash = event.inputHash || contentHash(event.inputSummary)

  // Log to debug file immediately (sync)
  routerLog(`${event.decisionType}${event.decisionSubtype ? ':' + event.decisionSubtype : ''} → ${event.outcome} (${event.reasoning || 'no reason'})`)

  // Build embedding text from input + outcome
  const embeddingText = `${event.decisionType}: ${event.inputSummary} → ${event.outcome}`
  const embedding = await getEmbedding(embeddingText)

  const record: Record<string, unknown> = {
    id,
    session_id: event.sessionId || 'unknown',
    timestamp,
    decision_type: event.decisionType,
    decision_subtype: event.decisionSubtype || '',
    input_summary: event.inputSummary.substring(0, 1000),
    input_hash: inputHash,
    outcome: event.outcome,
    reasoning: event.reasoning || '',
    alternatives: event.alternatives ? JSON.stringify(event.alternatives) : '[]',
    scores: event.scores ? JSON.stringify(event.scores) : '{}',
    latency_ms: event.latencyMs || 0,
    tags: event.tags?.join(',') || '',
    embedding,
  }

  await ingest(record)
}

// ── Specialized Capture Functions ─────────────────────────────────────────────

/**
 * Capture routing decision (local/reason/escalate)
 */
export async function captureRoutingDecision(params: {
  userQuery: string
  decision: 'local' | 'reason' | 'escalate'
  model: string
  confidence: number
  reasoning?: string
  suggestedTool?: string
  fromCache?: boolean
  retryCount?: number
  context?: DecisionCaptureContext
}): Promise<void> {
  const alternatives: Alternative[] = [
    { option: 'local', score: params.decision === 'local' ? params.confidence : 1 - params.confidence },
    { option: 'reason', score: params.decision === 'reason' ? params.confidence : 0 },
    { option: 'escalate', score: params.decision === 'escalate' ? params.confidence : 0 },
  ]

  await captureDecision({
    sessionId: params.context?.sessionId,
    decisionType: params.fromCache ? 'cache_hit' : 'routing',
    decisionSubtype: params.decision,
    inputSummary: params.userQuery.substring(0, 500),
    outcome: `${params.decision} → ${params.model}`,
    reasoning: params.reasoning,
    alternatives,
    scores: {
      confidence: params.confidence,
      retryCount: params.retryCount,
    },
    tags: params.suggestedTool ? ['tool:' + params.suggestedTool] : undefined,
  })
}

/**
 * Capture memory selection decision
 */
export async function captureMemorySelection(params: {
  query: string
  selectedFiles: string[]
  selector: 'vector' | 'llm' | 'fallback'
  latencyMs: number
  indexStatus?: string
  topDistances?: number[]
  context?: DecisionCaptureContext
}): Promise<void> {
  const alternatives: Alternative[] = params.selectedFiles.map((file, i) => ({
    option: file,
    score: params.topDistances?.[i],
  }))

  await captureDecision({
    sessionId: params.context?.sessionId,
    decisionType: 'memory_select',
    decisionSubtype: params.selector,
    inputSummary: params.query.substring(0, 500),
    outcome: params.selectedFiles.length > 0 
      ? `Selected ${params.selectedFiles.length}: ${params.selectedFiles.slice(0, 3).join(', ')}`
      : 'No memories selected',
    reasoning: `selector=${params.selector}, index=${params.indexStatus || 'unknown'}`,
    alternatives,
    scores: {
      latencyMs: params.latencyMs,
      resultCount: params.selectedFiles.length,
    },
    latencyMs: params.latencyMs,
    tags: [`selector:${params.selector}`, `index:${params.indexStatus || 'unknown'}`],
  })
}

/**
 * Capture query dedup decision
 */
export async function captureQueryDedup(params: {
  query: string
  isDuplicate: boolean
  reason: 'exact' | 'semantic' | 'none'
  distance?: number
  similarQuery?: string
  threshold: number
  context?: DecisionCaptureContext
}): Promise<void> {
  const alternatives: Alternative[] = params.similarQuery
    ? [{ option: params.similarQuery, score: params.distance }]
    : []

  await captureDecision({
    sessionId: params.context?.sessionId,
    decisionType: 'query_dedup',
    decisionSubtype: params.reason,
    inputSummary: params.query.substring(0, 500),
    outcome: params.isDuplicate 
      ? `DUPLICATE (${params.reason}, d=${params.distance?.toFixed(3) || 'N/A'})`
      : 'NOVEL',
    reasoning: params.similarQuery 
      ? `Similar to: "${params.similarQuery.substring(0, 100)}"`
      : `No similar queries (threshold=${params.threshold})`,
    alternatives,
    scores: {
      distance: params.distance,
      threshold: params.threshold,
    },
    tags: params.isDuplicate ? ['duplicate', `reason:${params.reason}`] : ['novel'],
  })
}

/**
 * Capture tool suggestion decision
 */
export async function captureToolSuggestion(params: {
  userQuery: string
  suggestedTool: string
  confidence: number
  reasoning?: string
  availableTools?: string[]
  context?: DecisionCaptureContext
}): Promise<void> {
  const alternatives: Alternative[] = (params.availableTools || [])
    .filter(t => t !== params.suggestedTool)
    .slice(0, 5)
    .map(t => ({ option: t }))

  await captureDecision({
    sessionId: params.context?.sessionId,
    decisionType: 'tool_suggest',
    inputSummary: params.userQuery.substring(0, 500),
    outcome: params.suggestedTool,
    reasoning: params.reasoning,
    alternatives,
    scores: {
      confidence: params.confidence,
      toolCount: params.availableTools?.length,
    },
    tags: ['tool:' + params.suggestedTool],
  })
}

/**
 * Capture force-answer trigger
 */
export async function captureForceAnswer(params: {
  userQuery: string
  loopedTool: string
  loopCount: number
  hadSearchResults: boolean
  context?: DecisionCaptureContext
}): Promise<void> {
  await captureDecision({
    sessionId: params.context?.sessionId,
    decisionType: 'force_answer',
    decisionSubtype: params.hadSearchResults ? 'with_results' : 'no_results',
    inputSummary: params.userQuery.substring(0, 500),
    outcome: `Forced answer after ${params.loopCount} loops on ${params.loopedTool}`,
    reasoning: params.hadSearchResults 
      ? 'Search results available, forcing synthesis'
      : 'No results but loop detected, forcing generic answer',
    scores: {
      loopCount: params.loopCount,
    },
    tags: ['force_answer', 'tool:' + params.loopedTool],
  })
}

/**
 * Capture index rebuild event
 */
export async function captureIndexRebuild(params: {
  indexType: 'memory' | 'query'
  recordCount: number
  latencyMs: number
  trigger: 'stale' | 'empty' | 'manual'
  context?: DecisionCaptureContext
}): Promise<void> {
  await captureDecision({
    sessionId: params.context?.sessionId,
    decisionType: 'index_rebuild',
    decisionSubtype: params.indexType,
    inputSummary: `Rebuild ${params.indexType} index (${params.trigger})`,
    outcome: `Indexed ${params.recordCount} records in ${params.latencyMs}ms`,
    reasoning: `Trigger: ${params.trigger}`,
    scores: {
      resultCount: params.recordCount,
      latencyMs: params.latencyMs,
    },
    latencyMs: params.latencyMs,
    tags: [`index:${params.indexType}`, `trigger:${params.trigger}`],
  })
}

// ── CLI ───────────────────────────────────────────────────────────────────────

if (import.meta.main || process.argv[1]?.endsWith('decisionCapture.ts')) {
  const [cmd, ...args] = process.argv.slice(2)

  async function main() {
    switch (cmd) {
      case 'stats': {
        const res = await fetch(`${LANCEDB_URI}/dbs/${DB}/tables/${TABLE}/query`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ limit: 10000 }),
        })
        
        if (!res.ok) {
          console.log('Table not found or empty')
          break
        }

        const data = await res.json() as { records?: Array<{ decision_type: string; timestamp: number }> }
        const records = data.records || []
        
        console.log('Decision Event Statistics:')
        console.log('==========================')
        console.log(`Total events: ${records.length}`)
        
        if (records.length > 0) {
          const byType = new Map<string, number>()
          const lastHour = Date.now() - 3600000
          let recentCount = 0

          for (const r of records) {
            byType.set(r.decision_type, (byType.get(r.decision_type) ?? 0) + 1)
            if (r.timestamp > lastHour) recentCount++
          }

          console.log(`Last hour: ${recentCount}`)
          console.log('\nBy type:')
          for (const [type, count] of byType) {
            console.log(`  ${type}: ${count}`)
          }
        }
        break
      }

      case 'recent': {
        const limit = parseInt(args[0]) || 20
        const res = await fetch(`${LANCEDB_URI}/dbs/${DB}/tables/${TABLE}/query`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ limit }),
        })
        
        if (!res.ok) {
          console.log('Table not found or empty')
          break
        }

        const data = await res.json() as { records?: Array<Record<string, unknown>> }
        const records = (data.records || [])
          .sort((a, b) => (b.timestamp as number) - (a.timestamp as number))
          .slice(0, limit)

        for (const r of records) {
          const ts = new Date(r.timestamp as number).toISOString()
          console.log(`[${ts}] ${r.decision_type}${r.decision_subtype ? ':' + r.decision_subtype : ''} → ${r.outcome}`)
          if (r.reasoning) console.log(`    ${r.reasoning}`)
        }
        break
      }

      case 'test': {
        console.log('Testing decision capture...\n')

        await captureRoutingDecision({
          userQuery: 'What is the weather today?',
          decision: 'local',
          model: 'qwen2.5:7b-instruct',
          confidence: 0.85,
          reasoning: 'Simple factual query',
        })
        console.log('✓ Routing decision captured')

        await captureMemorySelection({
          query: 'How do I configure OAuth?',
          selectedFiles: ['oauth-setup.md', 'auth-patterns.md'],
          selector: 'vector',
          latencyMs: 45,
          indexStatus: 'fresh',
          topDistances: [0.32, 0.41],
        })
        console.log('✓ Memory selection captured')

        await captureQueryDedup({
          query: 'US stock market today',
          isDuplicate: true,
          reason: 'semantic',
          distance: 0.28,
          similarQuery: 'US stock market analysis',
          threshold: 0.35,
        })
        console.log('✓ Query dedup captured')

        console.log('\nDone. Run `stats` to see results.')
        break
      }

      default:
        console.log(`Decision Capture — Unified decision event tracking

Commands:
  stats              Show capture statistics
  recent [N]         Show N most recent events (default: 20)
  test               Capture test events

Environment:
  DECISION_CAPTURE         Enable/disable (default: true)
  DECISION_CAPTURE_VERBOSE Enable verbose logging
  LANCEDB_URI              LanceDB REST API URL
`)
    }
  }

  main().catch(console.error)
}

export default {
  captureDecision,
  captureRoutingDecision,
  captureMemorySelection,
  captureQueryDedup,
  captureToolSuggestion,
  captureForceAnswer,
  captureIndexRebuild,
  isDecisionCaptureEnabled,
}
