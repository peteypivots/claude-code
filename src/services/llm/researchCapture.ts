/**
 * researchCapture.ts — Automatic Research Findings Capture
 *
 * Intercepts MCP tool results containing structured research responses
 * (e.g., from meta-ai, or any MCP returning {response, reasoning[], sources[]})
 * and automatically decomposes them into individual LanceDB records.
 *
 * This runs fire-and-forget from queryModelRouter.ts, same pattern as
 * trainingCapture.ts. Pipelines don't need to know about storage.
 *
 * Environment:
 *   LANCEDB_URI              — LanceDB REST API (default: http://lancedb-api:8000)
 *   OLLAMA_BASE_URL          — Ollama for embeddings (default: http://ollama:11434)
 *   EMBEDDING_MODEL          — Embedding model (default: nomic-embed-text)
 */

import { createHash, randomUUID } from 'crypto'

// ── Config ────────────────────────────────────────────────────────────────────
const LANCEDB_URI = process.env.LANCEDB_URI || 'http://lancedb-api:8000'
const OLLAMA_BASE_URL = process.env.OLLAMA_BASE_URL || 'http://ollama:11434'
const EMBEDDING_MODEL = process.env.EMBEDDING_MODEL || 'nomic-embed-text'
const DB = 'user_dbs'
const TABLE = 'research_findings'
const NITTER_POSTS_TABLE = 'nitter_posts'
const NITTER_USERS_TABLE = 'nitter_users'
const NITTER_RELATIONSHIPS_TABLE = 'nitter_relationships'

// Fields that exist in the LanceDB research_findings table schema.
const TABLE_SCHEMA_FIELDS = new Set([
  'id', 'query', 'canonical_query', 'source_url', 'domain', 'title',
  'summary', 'key_points', 'entities', 'tags', 'timestamp',
  'source_rank', 'source_tier', 'content_hash', 'embedding',
])

// ── Types ─────────────────────────────────────────────────────────────────────

/** Shape of a structured research response from an MCP tool */
interface StructuredResearchResponse {
  response: string
  reasoning?: string[]
  sources?: Array<{ tool?: string; args?: Record<string, unknown>; query?: string }>
  frame_count?: number
}

interface ResearchCaptureContext {
  sessionId?: string
  model?: string
  routingDecision?: string
}

/** Shape of a nitter tweet from MCP tool results */
interface NitterTweet {
  tweet_id: string
  username: string
  text: string
  pub_date?: string
  permalink?: string
  mentions?: string[]
  hashtags?: string[]
  media_urls?: string[]
  entities?: string[]
  key_topics?: string[]
}

/** Shape of a nitter user profile from MCP tool results */
interface NitterUser {
  username: string
  display_name?: string
  bio?: string
  follower_estimate?: number
  category?: string
  discovered_from?: string
  discovery_method?: string
  tags?: string[]
}

/** Shape of a nitter relationship from MCP tool results */
interface NitterRelationship {
  source_user: string
  target_user: string
  relationship_type: string
  context?: string
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function log(msg: string, level: 'info' | 'warn' | 'error' = 'info') {
  const prefix = level === 'error' ? '❌' : level === 'warn' ? '⚠️' : '📝'
  console.log(`[ResearchCapture] ${prefix} ${msg}`)
}

function routerLog(msg: string) {
  try {
    const { appendFileSync } = require('fs')
    const logPath = process.env.OLLAMA_DEBUG_LOG_FILE || '/data/logs/router-debug.log'
    appendFileSync(logPath, `[${new Date().toISOString()}] [RESEARCH_CAPTURE] ${msg}\n`)
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

function canonicalQuery(query: string): string {
  return query.toLowerCase().replace(/[^a-z0-9 ]/g, '').replace(/\s+/g, ' ').trim()
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
      log(`Stored: ${filtered.id} (rank=${filtered.source_rank})`)
      routerLog(`Stored: ${filtered.id} (rank=${filtered.source_rank}, title=${filtered.title})`)
      return true
    } else {
      const body = await res.text()
      log(`Ingest failed: ${res.status} - ${body.substring(0, 200)}`, 'error')
      routerLog(`Ingest failed: ${res.status} - ${body.substring(0, 200)}`)
      return false
    }
  } catch (e) {
    log(`Ingest error: ${e}`, 'error')
    routerLog(`Ingest error: ${e}`)
    return false
  }
}

// ── Dedup Check ───────────────────────────────────────────────────────────────

async function isDuplicate(hash: string): Promise<boolean> {
  try {
    const res = await fetch(`${LANCEDB_URI}/dbs/${DB}/tables/${TABLE}/query`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ filter: `content_hash = '${hash}'`, limit: 1 }),
      signal: AbortSignal.timeout(5000),
    })
    if (!res.ok) return false
    const data = (await res.json()) as { records?: unknown[] }
    return (data.records?.length ?? 0) > 0
  } catch {
    return false
  }
}

// ── Detection ─────────────────────────────────────────────────────────────────

/**
 * Check if a tool result string contains structured research JSON.
 * Looks for objects with a `response` field and optionally `reasoning`/`sources` arrays.
 */
export function isStructuredResearch(toolResult: string): StructuredResearchResponse | null {
  try {
    // Try parsing as JSON directly
    let parsed: unknown
    try {
      parsed = JSON.parse(toolResult)
    } catch {
      // Try extracting JSON from markdown fences or prose
      const jsonMatch = toolResult.match(/```(?:json)?\s*(\{[\s\S]*?\})\s*```/)
        || toolResult.match(/(\{[\s\S]*"response"[\s\S]*\})/)
      if (!jsonMatch) return null
      parsed = JSON.parse(jsonMatch[1])
    }

    if (!parsed || typeof parsed !== 'object') return null

    const obj = parsed as Record<string, unknown>

    // Must have a `response` string
    if (typeof obj.response !== 'string' || obj.response.length < 10) return null

    // Must have at least one of reasoning or sources to be "structured"
    const hasReasoning = Array.isArray(obj.reasoning) && obj.reasoning.length > 0
    const hasSources = Array.isArray(obj.sources) && obj.sources.length > 0
    if (!hasReasoning && !hasSources) return null

    // Skip error responses
    if (obj.error === true) return null

    return {
      response: obj.response as string,
      reasoning: hasReasoning ? (obj.reasoning as string[]) : undefined,
      sources: hasSources ? (obj.sources as StructuredResearchResponse['sources']) : undefined,
      frame_count: typeof obj.frame_count === 'number' ? obj.frame_count : undefined,
    }
  } catch {
    return null
  }
}

// ── Nitter Ingest ─────────────────────────────────────────────────────────────

async function ingestToTable(table: string, record: Record<string, unknown>): Promise<boolean> {
  try {
    const res = await fetch(`${LANCEDB_URI}/dbs/${DB}/tables/${table}/ingest`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ records: [record] }),
      signal: AbortSignal.timeout(10000),
    })
    if (res.ok) {
      routerLog(`Stored to ${table}: ${record.id}`)
      return true
    } else {
      const body = await res.text()
      routerLog(`Ingest to ${table} failed: ${res.status} - ${body.substring(0, 200)}`)
      return false
    }
  } catch (e) {
    routerLog(`Ingest to ${table} error: ${e}`)
    return false
  }
}

async function isDuplicateInTable(table: string, filterField: string, filterValue: string): Promise<boolean> {
  try {
    const res = await fetch(`${LANCEDB_URI}/dbs/${DB}/tables/${table}/query`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ filter: `${filterField} = '${filterValue}'`, limit: 1 }),
      signal: AbortSignal.timeout(5000),
    })
    if (!res.ok) return false
    const data = (await res.json()) as { records?: unknown[] }
    return (data.records?.length ?? 0) > 0
  } catch {
    return false
  }
}

// ── Nitter Detection ──────────────────────────────────────────────────────────

/** Detect if a parsed object is a nitter tweet */
function isNitterTweet(obj: Record<string, unknown>): obj is NitterTweet {
  return typeof obj.tweet_id === 'string' && typeof obj.username === 'string' && typeof obj.text === 'string'
}

/** Detect if a parsed object is a nitter user */
function isNitterUser(obj: Record<string, unknown>): obj is NitterUser {
  return typeof obj.username === 'string' && (typeof obj.bio === 'string' || typeof obj.follower_estimate === 'number' || typeof obj.display_name === 'string')
    && !('tweet_id' in obj) && !('text' in obj)
}

/** Detect if a parsed object is a nitter relationship */
function isNitterRelationship(obj: Record<string, unknown>): obj is NitterRelationship {
  return typeof obj.source_user === 'string' && typeof obj.target_user === 'string' && typeof obj.relationship_type === 'string'
}

/**
 * Try to extract nitter data from a tool result string.
 * Returns arrays of detected tweets, users, and relationships.
 */
function extractNitterData(toolResult: string): { tweets: NitterTweet[], users: NitterUser[], relationships: NitterRelationship[] } {
  const tweets: NitterTweet[] = []
  const users: NitterUser[] = []
  const relationships: NitterRelationship[] = []

  try {
    let parsed: unknown
    try {
      parsed = JSON.parse(toolResult)
    } catch {
      // Try extracting JSON from markdown fences
      const jsonMatch = toolResult.match(/```(?:json)?\s*([\[{][\s\S]*?[}\]])\s*```/)
      if (jsonMatch) {
        parsed = JSON.parse(jsonMatch[1])
      } else {
        return { tweets, users, relationships }
      }
    }

    // Normalize to array
    const items = Array.isArray(parsed) ? parsed : [parsed]

    // Also check nested fields like .tweets, .users, .results, .data
    const containers = [...items]
    for (const item of items) {
      if (item && typeof item === 'object') {
        const obj = item as Record<string, unknown>
        for (const key of ['tweets', 'users', 'results', 'data', 'relationships', 'follows']) {
          if (Array.isArray(obj[key])) {
            containers.push(...(obj[key] as unknown[]))
          }
        }
      }
    }

    for (const item of containers) {
      if (!item || typeof item !== 'object') continue
      const obj = item as Record<string, unknown>
      if (isNitterTweet(obj)) tweets.push(obj)
      else if (isNitterRelationship(obj)) relationships.push(obj)
      else if (isNitterUser(obj)) users.push(obj)
    }
  } catch {}

  return { tweets, users, relationships }
}

// ── Nitter Storage ────────────────────────────────────────────────────────────

async function storeNitterTweet(tweet: NitterTweet): Promise<boolean> {
  const hash = contentHash(tweet.tweet_id)
  if (await isDuplicateInTable(NITTER_POSTS_TABLE, 'content_hash', hash)) return false

  const embedding = await getEmbedding(tweet.text)
  const record: Record<string, unknown> = {
    id: randomUUID(),
    content_hash: hash,
    timestamp: new Date().toISOString(),
    tweet_id: tweet.tweet_id,
    username: tweet.username,
    text: tweet.text,
    pub_date: tweet.pub_date || '',
    permalink: tweet.permalink || '',
    mentions: tweet.mentions || [],
    hashtags: tweet.hashtags || [],
    media_urls: tweet.media_urls || [],
    entities: tweet.entities || [],
    key_topics: tweet.key_topics || [],
  }
  if (embedding) record.embedding = embedding
  return ingestToTable(NITTER_POSTS_TABLE, record)
}

async function storeNitterUser(user: NitterUser): Promise<boolean> {
  const usernameLower = user.username.toLowerCase()
  if (await isDuplicateInTable(NITTER_USERS_TABLE, 'username_lower', usernameLower)) return false

  const bioText = `${user.username} ${user.bio || ''}`
  const embedding = await getEmbedding(bioText)
  const now = new Date().toISOString()
  const record: Record<string, unknown> = {
    id: randomUUID(),
    username: user.username,
    username_lower: usernameLower,
    display_name: user.display_name || '',
    bio: user.bio || '',
    follower_estimate: user.follower_estimate || 0,
    category: user.category || 'unknown',
    discovered_from: user.discovered_from || 'mcp',
    discovery_method: user.discovery_method || 'llm_router',
    first_seen: now,
    last_crawled: now,
    crawl_priority: 0.5,
    tags: user.tags || [],
  }
  if (embedding) record.embedding = embedding
  return ingestToTable(NITTER_USERS_TABLE, record)
}

async function storeNitterRelationship(rel: NitterRelationship): Promise<boolean> {
  const edgeHash = contentHash(`${rel.source_user.toLowerCase()}:${rel.target_user.toLowerCase()}:${rel.relationship_type}`)
  // Relationships are stored without dedup (count = weight)
  const now = new Date().toISOString()
  const record: Record<string, unknown> = {
    id: randomUUID(),
    source_user: rel.source_user.toLowerCase(),
    target_user: rel.target_user.toLowerCase(),
    relationship_type: rel.relationship_type,
    edge_hash: edgeHash,
    first_seen: now,
    last_seen: now,
    context: rel.context || '',
  }
  return ingestToTable(NITTER_RELATIONSHIPS_TABLE, record)
}

// ── Decompose & Store ─────────────────────────────────────────────────────────

/**
 * Decompose a structured research response into individual LanceDB records.
 * Creates:
 *   1. Primary response record (source_rank 0.7)
 *   2. One record per reasoning step (source_rank 0.5)
 *   3. One record per source (source_rank 0.3)
 */
async function decomposeAndStore(
  structured: StructuredResearchResponse,
  query: string,
  toolName: string,
  context?: ResearchCaptureContext,
): Promise<number> {
  const timestamp = new Date().toISOString()
  const canon = canonicalQuery(query)
  let stored = 0

  // 1. Primary response
  const primaryHash = contentHash(query + structured.response)
  if (!(await isDuplicate(primaryHash))) {
    const embedding = await getEmbedding(`${query}\n${structured.response}`)
    const record: Record<string, unknown> = {
      id: randomUUID(),
      query,
      canonical_query: canon,
      source_url: `${toolName}://research/${canon.replace(/\s+/g, '-')}`,
      domain: toolName.replace(/^mcp_/, '').replace(/_/g, '.'),
      title: `${toolName}: ${query}`.substring(0, 200),
      summary: structured.response.substring(0, 2000),
      key_points: structured.reasoning ?? [],
      entities: [],
      tags: [toolName, 'web-research', 'primary'],
      timestamp,
      source_rank: 0.7,
      source_tier: toolName.replace(/^mcp_/, '').replace(/_/g, '_'),
      content_hash: primaryHash,
    }
    if (embedding) record.embedding = embedding
    if (await ingest(record)) stored++
  } else {
    routerLog(`Dedup: primary response for "${query.substring(0, 50)}" already exists`)
  }

  // 2. Reasoning steps
  if (structured.reasoning) {
    for (let i = 0; i < structured.reasoning.length; i++) {
      const step = structured.reasoning[i]
      if (typeof step !== 'string' || step.length < 5) continue

      const stepHash = contentHash(`reasoning-${i}-${query}-${step}`)
      if (await isDuplicate(stepHash)) continue

      const embedding = await getEmbedding(step)
      const record: Record<string, unknown> = {
        id: randomUUID(),
        query,
        canonical_query: canon,
        source_url: `${toolName}://reasoning/${canon.replace(/\s+/g, '-')}/${i}`,
        domain: toolName.replace(/^mcp_/, '').replace(/_/g, '.'),
        title: `Reasoning step ${i + 1}: ${query}`.substring(0, 200),
        summary: step.substring(0, 2000),
        key_points: [step],
        entities: [],
        tags: [toolName, 'reasoning', `step-${i + 1}`],
        timestamp,
        source_rank: 0.5,
        source_tier: 'reasoning',
        content_hash: stepHash,
      }
      if (embedding) record.embedding = embedding
      if (await ingest(record)) stored++
    }
  }

  // 3. Sources
  if (structured.sources) {
    for (let i = 0; i < structured.sources.length; i++) {
      const source = structured.sources[i]
      const sourceText = source.query
        || source.tool
        || (source.args?.primary_query_info as Record<string, unknown>)?.query as string
        || JSON.stringify(source)
      if (sourceText.length < 3) continue

      const sourceHash = contentHash(`source-${i}-${query}-${sourceText}`)
      if (await isDuplicate(sourceHash)) continue

      const embedding = await getEmbedding(`${query} source: ${sourceText}`)
      const record: Record<string, unknown> = {
        id: randomUUID(),
        query,
        canonical_query: canon,
        source_url: `${toolName}://source/${canon.replace(/\s+/g, '-')}/${i}`,
        domain: source.tool || toolName.replace(/^mcp_/, '').replace(/_/g, '.'),
        title: `Source ${i + 1}: ${sourceText}`.substring(0, 200),
        summary: typeof sourceText === 'string' ? sourceText.substring(0, 2000) : JSON.stringify(source).substring(0, 2000),
        key_points: [sourceText],
        entities: [],
        tags: [toolName, 'source', source.tool || 'unknown'].filter(Boolean),
        timestamp,
        source_rank: 0.3,
        source_tier: 'source',
        content_hash: sourceHash,
      }
      if (embedding) record.embedding = embedding
      if (await ingest(record)) stored++
    }
  }

  return stored
}

// ── Public API ────────────────────────────────────────────────────────────────

export function isResearchCaptureEnabled(): boolean {
  return true
}

/**
 * Scan MCP tool results for structured research responses and store them.
 * Called fire-and-forget from queryModelRouter.ts after tool execution.
 *
 * @param toolResultMap - Map of tool_use_id → result content string
 * @param toolCalls     - Array of {name, arguments, result} from the conversation
 * @param userQuery     - The user's original query
 * @param context       - Optional routing/session context
 * @returns Number of records stored
 */
export async function captureResearchFindings(
  toolResultMap: Map<string, string>,
  toolCalls: Array<{ name: string; arguments: string; result?: string }>,
  userQuery: string,
  context?: ResearchCaptureContext,
): Promise<number> {
  let totalStored = 0

  // Build a map of tool_use_id → tool name for attribution
  const toolNameByResult = new Map<string, string>()
  for (const tc of toolCalls) {
    // Match tool calls to results by position or content
    for (const [id, content] of toolResultMap) {
      if (!toolNameByResult.has(id)) {
        toolNameByResult.set(id, tc.name)
        break
      }
    }
  }

  // Scan all tool results for structured research responses AND nitter data
  for (const [toolUseId, resultContent] of toolResultMap) {
    // Check for structured research
    const structured = isStructuredResearch(resultContent)
    if (structured) {
      const toolName = toolNameByResult.get(toolUseId) || 'unknown_mcp'
      routerLog(`Detected structured research in ${toolName} (response=${structured.response.length}ch, reasoning=${structured.reasoning?.length ?? 0}, sources=${structured.sources?.length ?? 0})`)

      try {
        const count = await decomposeAndStore(structured, userQuery, toolName, context)
        totalStored += count
        routerLog(`Stored ${count} records from ${toolName} for query: "${userQuery.substring(0, 80)}"`)
      } catch (e) {
        routerLog(`Error decomposing ${toolName} result: ${e}`)
        log(`Error decomposing ${toolName} result: ${e}`, 'error')
      }
    }

    // Check for nitter data (tweets, users, relationships)
    const nitterData = extractNitterData(resultContent)
    const nitterTotal = nitterData.tweets.length + nitterData.users.length + nitterData.relationships.length
    if (nitterTotal > 0) {
      const toolName = toolNameByResult.get(toolUseId) || 'unknown_mcp'
      routerLog(`Detected nitter data in ${toolName}: ${nitterData.tweets.length} tweets, ${nitterData.users.length} users, ${nitterData.relationships.length} relationships`)

      for (const tweet of nitterData.tweets) {
        try {
          if (await storeNitterTweet(tweet)) totalStored++
        } catch (e) {
          routerLog(`Error storing nitter tweet ${tweet.tweet_id}: ${e}`)
        }
      }
      for (const user of nitterData.users) {
        try {
          if (await storeNitterUser(user)) totalStored++
        } catch (e) {
          routerLog(`Error storing nitter user ${user.username}: ${e}`)
        }
      }
      for (const rel of nitterData.relationships) {
        try {
          if (await storeNitterRelationship(rel)) totalStored++
        } catch (e) {
          routerLog(`Error storing nitter relationship: ${e}`)
        }
      }
    }
  }

  if (totalStored > 0) {
    routerLog(`Total research records stored: ${totalStored}`)
  }

  return totalStored
}
