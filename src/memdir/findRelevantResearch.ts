/**
 * findRelevantResearch.ts — Vector-based research findings recall
 * 
 * Queries the LanceDB research_findings table to surface past research
 * relevant to a query. Uses semantic search via embeddings.
 * 
 * Architecture:
 *   1. Embed the query using Ollama's nomic-embed-text
 *   2. Vector search in research_findings table
 *   3. Return top matches formatted for injection
 * 
 * Table: research_findings (in user_dbs)
 * Schema: id, query, canonical_query, source_url, domain, title, summary,
 *         key_points, entities, tags, timestamp, source_rank, source_tier,
 *         content_hash, embedding
 * 
 * Environment:
 *   OLLAMA_BASE_URL       — Ollama API (default: http://ollama:11434)
 *   EMBEDDING_MODEL       — Model for embeddings (default: nomic-embed-text)
 *   LANCEDB_URI           — LanceDB REST API (default: http://lancedb-api:8000)
 *   RESEARCH_RECALL_VERBOSE — Enable debug logging
 */

import { appendFileSync } from 'fs'

// ── Configuration ─────────────────────────────────────────────────────────────

const OLLAMA_BASE_URL = process.env.OLLAMA_BASE_URL ?? 'http://ollama:11434'
const EMBEDDING_MODEL = process.env.EMBEDDING_MODEL ?? 'nomic-embed-text'
const LANCEDB_URI = process.env.LANCEDB_URI ?? 'http://lancedb-api:8000'
const DB = 'user_dbs'
const TABLE = 'research_findings'
const VERBOSE = process.env.RESEARCH_RECALL_VERBOSE === 'true'

const MAX_RESULTS = 5
const MIN_RELEVANCE_SCORE = 0.70  // cosine distance threshold (nomic-embed-text: 0.4-0.6 typical)

// ── Types ─────────────────────────────────────────────────────────────────────

export interface ResearchFinding {
  id: string
  query: string
  canonical_query: string
  source_url: string
  domain: string
  title: string
  summary: string
  key_points: string[]
  entities: string[]
  tags: string[]
  timestamp: string
  source_rank: number
  source_tier: string
  content_hash: string
  /** Distance from query (lower = more similar) */
  _distance?: number
}

export interface ResearchRecallResult {
  findings: ResearchFinding[]
  latencyMs: number
  queryEmbedded: boolean
}

// ── Logging ───────────────────────────────────────────────────────────────────

const ROUTER_DEBUG_LOG = process.env.ROUTER_DEBUG_LOG ?? '/data/logs/router-debug.log'

function log(msg: string): void {
  if (VERBOSE) {
    console.error(`[research-recall] ${msg}`)
  }
}

function routerLog(msg: string): void {
  const ts = new Date().toISOString()
  try {
    appendFileSync(ROUTER_DEBUG_LOG, `${ts} [ResearchRecall] ${msg}\n`)
  } catch { /* ignore */ }
}

// ── Embedding Functions ───────────────────────────────────────────────────────

interface EmbeddingResponse {
  embeddings?: number[][]
}

async function embed(text: string): Promise<number[] | null> {
  try {
    const res = await fetch(`${OLLAMA_BASE_URL}/api/embed`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: EMBEDDING_MODEL, input: text.substring(0, 2000) }),
      signal: AbortSignal.timeout(10000),
    })
    if (!res.ok) {
      log(`Embedding failed: ${res.status}`)
      return null
    }
    const data = (await res.json()) as EmbeddingResponse
    return data.embeddings?.[0] ?? null
  } catch (e) {
    log(`Embedding error: ${e}`)
    return null
  }
}

// ── LanceDB Search ────────────────────────────────────────────────────────────

interface SearchResponse {
  results?: ResearchFinding[]
  count?: number
}

async function searchResearch(embedding: number[], maxResults: number): Promise<ResearchFinding[]> {
  try {
    const res = await fetch(`${LANCEDB_URI}/dbs/${DB}/tables/${TABLE}/search`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        query_vector: embedding,
        top_k: maxResults,
        columns: [
          'id', 'query', 'canonical_query', 'source_url', 'domain', 'title',
          'summary', 'key_points', 'entities', 'tags', 'timestamp',
          'source_rank', 'source_tier', 'content_hash'
        ]
      }),
      signal: AbortSignal.timeout(10000),
    })

    if (!res.ok) {
      const body = await res.text()
      log(`Search failed: ${res.status} - ${body.substring(0, 200)}`)
      return []
    }

    const data = (await res.json()) as SearchResponse
    return data.results ?? []
  } catch (e) {
    log(`Search error: ${e}`)
    return []
  }
}

// ── Health Check ──────────────────────────────────────────────────────────────

async function isLanceDBAvailable(): Promise<boolean> {
  try {
    // LanceDB API doesn't have a /health endpoint, so check if we can list tables
    const res = await fetch(`${LANCEDB_URI}/dbs/${DB}/tables`, {
      method: 'GET',
      signal: AbortSignal.timeout(3000),
    })
    return res.ok
  } catch {
    return false
  }
}

// ── Main Entry Point ──────────────────────────────────────────────────────────

/**
 * Find research findings relevant to a query by semantic search.
 * Returns matching findings from the research_findings table.
 * 
 * @param query - The user's query/input
 * @param maxResults - Maximum findings to return (default: 5)
 * @param minScore - Minimum relevance (max distance, default: 0.25)
 */
export async function findRelevantResearch(
  query: string,
  maxResults: number = MAX_RESULTS,
  minScore: number = MIN_RELEVANCE_SCORE,
): Promise<ResearchRecallResult> {
  const start = Date.now()
  routerLog(`ENTER findRelevantResearch: query="${query.slice(0, 50)}..."`)

  // Check if LanceDB is available
  if (!(await isLanceDBAvailable())) {
    log('LanceDB unavailable')
    routerLog('LanceDB unavailable, skipping research recall')
    return { findings: [], latencyMs: Date.now() - start, queryEmbedded: false }
  }

  // Embed the query
  const embedding = await embed(query)
  if (!embedding) {
    log('Failed to embed query')
    routerLog('Failed to embed query, skipping research recall')
    return { findings: [], latencyMs: Date.now() - start, queryEmbedded: false }
  }

  // Search for relevant findings
  const results = await searchResearch(embedding, maxResults * 2)  // over-fetch for filtering
  
  // Filter by relevance score (distance)
  const filtered = results
    .filter(r => (r._distance ?? 1.0) < minScore)
    .slice(0, maxResults)

  const latencyMs = Date.now() - start
  routerLog(`Found ${filtered.length} relevant findings in ${latencyMs}ms`)
  log(`Found ${filtered.length} relevant findings in ${latencyMs}ms`)

  if (VERBOSE && filtered.length > 0) {
    for (const f of filtered) {
      log(`  - ${f.title} (${f.domain}, dist=${f._distance?.toFixed(3)})`)
    }
  }

  return { findings: filtered, latencyMs, queryEmbedded: true }
}

/**
 * Format research findings for injection into agent context.
 * Returns a formatted string suitable for a system reminder.
 */
export function formatResearchForContext(findings: ResearchFinding[]): string {
  if (findings.length === 0) return ''

  const lines: string[] = [
    '<relevant-research>',
    'The following research findings from previous sessions may be relevant.',
    '',
    'IMPORTANT: Only use this research if it is DIRECTLY relevant to the current query.',
    'If the research topic does not match what the user is asking about, IGNORE these findings.',
    'Do NOT mix information from unrelated topics into your response.',
    ''
  ]

  for (const f of findings) {
    lines.push(`### ${f.title}`)
    lines.push(`Source: ${f.domain} | ${f.timestamp}`)
    lines.push(`Query: "${f.query}"`)
    lines.push('')
    lines.push(f.summary)
    if (f.key_points && f.key_points.length > 0) {
      lines.push('')
      lines.push('Key points:')
      for (const point of f.key_points) {
        lines.push(`  - ${point}`)
      }
    }
    if (f.entities && f.entities.length > 0) {
      lines.push('')
      lines.push(`Entities: ${f.entities.join(', ')}`)
    }
    if (f.source_url) {
      lines.push(`URL: ${f.source_url}`)
    }
    lines.push('')
    lines.push('---')
    lines.push('')
  }

  lines.push('</relevant-research>')
  return lines.join('\n')
}

/**
 * Check if research recall is enabled.
 * Returns true when:
 *   - LOCAL_FIRST mode is active (env var set)
 *   - Not explicitly disabled via RESEARCH_RECALL_DISABLED
 */
export function isResearchRecallEnabled(): boolean {
  if (process.env.RESEARCH_RECALL_DISABLED === 'true') return false
  // Enable when local-first mode is active
  return !!(process.env.OLLAMA_BASE_URL || process.env.LOCAL_FIRST === 'true')
}
