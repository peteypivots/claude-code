/**
 * query-dedup.ts — Vector-based query deduplication
 * 
 * Prevents redundant queries by checking semantic similarity against
 * previously executed queries. Uses LanceDB for storage and Ollama
 * for embeddings.
 * 
 * Features:
 * - Query embedding index with timestamps
 * - Configurable similarity threshold
 * - Batch embedding for efficiency
 * - TTL-based expiration
 * 
 * Usage:
 *   import { QueryDedup } from './query-dedup.js'
 * 
 *   const dedup = new QueryDedup({ similarityThreshold: 0.15 })
 *   await dedup.init()
 * 
 *   // Check if query is novel
 *   const result = await dedup.check('US stock market today')
 *   if (result.isDuplicate) {
 *     console.log(`Similar to: ${result.similarQuery} (distance: ${result.distance})`)
 *   } else {
 *     // Run query...
 *     await dedup.record('US stock market today')
 *   }
 */

import { lancedbQuery, lancedbSearch, lancedbIngest, type LanceDBRecord } from '../../src/services/lancedb/index.js'
import { captureQueryDedup, isDecisionCaptureEnabled } from '../../src/services/llm/decisionCapture.js'

// ── Configuration ─────────────────────────────────────────────────────────────

const OLLAMA_BASE_URL = process.env.OLLAMA_BASE_URL ?? 'http://ollama:11434'
const EMBEDDING_MODEL = process.env.EMBEDDING_MODEL ?? 'nomic-embed-text'

const TABLE_NAME = 'query_embeddings'
const DEFAULT_SIMILARITY_THRESHOLD = 0.35  // Cosine distance (lower = more similar)
const DEFAULT_TTL_HOURS = 24  // Queries older than this are considered "fresh"

// ── Types ─────────────────────────────────────────────────────────────────────

export interface QueryDedupConfig {
  similarityThreshold?: number
  ttlHours?: number
  verbose?: boolean
}

export interface DedupCheckResult {
  isDuplicate: boolean
  distance?: number
  similarQuery?: string
  matchedAt?: number
  reason?: 'semantic' | 'exact' | 'none'
}

export interface QueryRecord {
  id: string
  query: string
  canonical_query: string
  embedding: number[]
  timestamp: number
  category?: string
  result_count?: number
}

interface EmbeddingResponse {
  embeddings?: number[][]
}

// ── Embedding Functions ───────────────────────────────────────────────────────

/**
 * Generate embedding for a single text
 */
async function embed(text: string): Promise<number[] | null> {
  try {
    const res = await fetch(`${OLLAMA_BASE_URL}/api/embed`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ 
        model: EMBEDDING_MODEL, 
        input: text.substring(0, 2000) 
      }),
      signal: AbortSignal.timeout(10000),
    })
    if (!res.ok) return null
    const data = (await res.json()) as EmbeddingResponse
    return data.embeddings?.[0] ?? null
  } catch {
    return null
  }
}

/**
 * Generate embeddings for multiple texts in one call
 */
async function embedBatch(texts: string[]): Promise<(number[] | null)[]> {
  if (texts.length === 0) return []
  
  try {
    const res = await fetch(`${OLLAMA_BASE_URL}/api/embed`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ 
        model: EMBEDDING_MODEL, 
        input: texts.map(t => t.substring(0, 2000))
      }),
      signal: AbortSignal.timeout(30000),
    })
    if (!res.ok) return texts.map(() => null)
    const data = (await res.json()) as EmbeddingResponse
    return data.embeddings ?? texts.map(() => null)
  } catch {
    return texts.map(() => null)
  }
}

/**
 * Normalize query for exact match comparison
 */
function canonicalize(query: string): string {
  return query
    .toLowerCase()
    .replace(/[^\w\s]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
}

/**
 * Generate unique ID from query
 */
function queryId(query: string): string {
  const crypto = require('crypto')
  return crypto.createHash('sha256').update(canonicalize(query)).digest('hex').substring(0, 16)
}

// ── QueryDedup Class ──────────────────────────────────────────────────────────

export class QueryDedup {
  private config: Required<QueryDedupConfig>
  private initialized = false
  private stats = {
    checks: 0,
    duplicates: 0,
    novel: 0,
    embedErrors: 0,
    searchErrors: 0,
  }

  constructor(config: QueryDedupConfig = {}) {
    this.config = {
      similarityThreshold: config.similarityThreshold ?? DEFAULT_SIMILARITY_THRESHOLD,
      ttlHours: config.ttlHours ?? DEFAULT_TTL_HOURS,
      verbose: config.verbose ?? false,
    }
  }

  private log(msg: string): void {
    if (this.config.verbose) {
      console.error(`[query-dedup] ${msg}`)
    }
  }

  /**
   * Initialize the dedup system (check table exists)
   */
  async init(): Promise<void> {
    if (this.initialized) return

    // Check if table exists by querying it
    const result = await lancedbQuery(TABLE_NAME, undefined, 1)
    if (result.error?.includes('not found') || result.error?.includes('does not exist')) {
      this.log(`Table ${TABLE_NAME} does not exist, will be created on first record`)
    } else {
      const count = result.records.length
      this.log(`Initialized. Table has records: ${count > 0}`)
    }
    
    this.initialized = true
  }

  /**
   * Check if a query is a duplicate of a recent query
   */
  async check(query: string): Promise<DedupCheckResult> {
    this.stats.checks++
    
    const canonical = canonicalize(query)
    const id = queryId(query)
    
    // Layer 1: Exact match (canonical form)
    const exactResult = await lancedbQuery(
      TABLE_NAME,
      `canonical_query = '${canonical.replace(/'/g, "''")}'`,
      1
    )
    
    if (exactResult.records.length > 0) {
      const match = exactResult.records[0] as unknown as QueryRecord
      this.stats.duplicates++
      this.log(`Exact match: "${query}" ≈ "${match.query}"`)
      
      // Capture decision
      if (isDecisionCaptureEnabled()) {
        captureQueryDedup({
          query,
          isDuplicate: true,
          reason: 'exact',
          distance: 0,
          similarQuery: match.query,
          threshold: this.config.similarityThreshold,
        }).catch(() => {})
      }
      
      return {
        isDuplicate: true,
        distance: 0,
        similarQuery: match.query,
        matchedAt: match.timestamp,
        reason: 'exact',
      }
    }

    // Layer 2: Semantic similarity
    const embedding = await embed(query)
    if (!embedding) {
      this.stats.embedErrors++
      this.log(`Embedding failed for: "${query}"`)
      return { isDuplicate: false, reason: 'none' }
    }

    // Search with TTL filter
    const cutoffMs = Date.now() - (this.config.ttlHours * 60 * 60 * 1000)
    const searchResult = await lancedbSearch(TABLE_NAME, embedding, 5)
    
    if (searchResult.error) {
      this.stats.searchErrors++
      this.log(`Search error: ${searchResult.error}`)
      return { isDuplicate: false, reason: 'none' }
    }

    // Find closest match within TTL
    for (const result of searchResult.results) {
      const record = result as unknown as QueryRecord & { _distance?: number }
      const distance = record._distance ?? 1.0
      
      // Check TTL
      if (record.timestamp && record.timestamp < cutoffMs) {
        continue  // Too old, consider fresh
      }
      
      if (distance < this.config.similarityThreshold) {
        this.stats.duplicates++
        this.log(`Semantic match: "${query}" ≈ "${record.query}" (d=${distance.toFixed(3)})`)
        
        // Capture decision
        if (isDecisionCaptureEnabled()) {
          captureQueryDedup({
            query,
            isDuplicate: true,
            reason: 'semantic',
            distance,
            similarQuery: record.query,
            threshold: this.config.similarityThreshold,
          }).catch(() => {})
        }
        
        return {
          isDuplicate: true,
          distance,
          similarQuery: record.query,
          matchedAt: record.timestamp,
          reason: 'semantic',
        }
      }
    }

    this.stats.novel++
    this.log(`Novel query: "${query}"`)
    
    // Capture novel decision
    if (isDecisionCaptureEnabled()) {
      captureQueryDedup({
        query,
        isDuplicate: false,
        reason: 'none',
        threshold: this.config.similarityThreshold,
      }).catch(() => {})
    }
    
    return { isDuplicate: false, reason: 'none' }
  }

  /**
   * Record a query that was executed
   */
  async record(query: string, metadata?: { category?: string; resultCount?: number }): Promise<boolean> {
    const embedding = await embed(query)
    if (!embedding) {
      this.log(`Failed to embed query for recording: "${query}"`)
      return false
    }

    const record: LanceDBRecord = {
      id: queryId(query),
      query,
      canonical_query: canonicalize(query),
      embedding,
      timestamp: Date.now(),
      category: metadata?.category,
      result_count: metadata?.resultCount,
    }

    const result = await lancedbIngest(TABLE_NAME, [record])
    if (!result.success) {
      this.log(`Failed to record query: ${result.error}`)
      return false
    }

    this.log(`Recorded: "${query}"`)
    return true
  }

  /**
   * Check multiple queries and return which are novel
   */
  async filterNovel(queries: string[]): Promise<{
    novel: string[]
    duplicates: Array<{ query: string; similarTo: string; distance: number }>
  }> {
    const novel: string[] = []
    const duplicates: Array<{ query: string; similarTo: string; distance: number }> = []

    // Batch embed all queries
    const embeddings = await embedBatch(queries)

    for (let i = 0; i < queries.length; i++) {
      const query = queries[i]!
      const embedding = embeddings[i]

      if (!embedding) {
        // Can't embed, assume novel
        novel.push(query)
        continue
      }

      // Check canonical match first
      const canonical = canonicalize(query)
      const exactResult = await lancedbQuery(
        TABLE_NAME,
        `canonical_query = '${canonical.replace(/'/g, "''")}'`,
        1
      )

      if (exactResult.records.length > 0) {
        const match = exactResult.records[0] as unknown as QueryRecord
        duplicates.push({ query, similarTo: match.query, distance: 0 })
        continue
      }

      // Semantic search
      const searchResult = await lancedbSearch(TABLE_NAME, embedding, 1)
      if (searchResult.results.length > 0) {
        const match = searchResult.results[0] as unknown as QueryRecord & { _distance?: number }
        const distance = match._distance ?? 1.0

        if (distance < this.config.similarityThreshold) {
          duplicates.push({ query, similarTo: match.query, distance })
          continue
        }
      }

      novel.push(query)
    }

    return { novel, duplicates }
  }

  /**
   * Record multiple queries at once
   */
  async recordBatch(queries: string[], category?: string): Promise<number> {
    const embeddings = await embedBatch(queries)
    const records: LanceDBRecord[] = []

    for (let i = 0; i < queries.length; i++) {
      const embedding = embeddings[i]
      if (!embedding) continue

      const query = queries[i]!
      records.push({
        id: queryId(query),
        query,
        canonical_query: canonicalize(query),
        embedding,
        timestamp: Date.now(),
        category,
      })
    }

    if (records.length === 0) return 0

    const result = await lancedbIngest(TABLE_NAME, records)
    return result.success ? records.length : 0
  }

  /**
   * Get statistics
   */
  getStats(): typeof this.stats {
    return { ...this.stats }
  }

  /**
   * Clear old queries (beyond TTL)
   */
  async prune(): Promise<number> {
    const cutoffMs = Date.now() - (this.config.ttlHours * 60 * 60 * 1000)
    
    // LanceDB doesn't have a direct DELETE, so we'd need to:
    // 1. Query all old records
    // 2. Drop and recreate table with remaining records
    // For now, just log — TTL is enforced at query time
    // NEW - there are ways via API see openai.json
    
    this.log(`Prune would remove queries older than ${new Date(cutoffMs).toISOString()}`)
    return 0  // Not implemented yet
  }
}

// ── CLI ───────────────────────────────────────────────────────────────────────

if (import.meta.main || process.argv[1]?.endsWith('query-dedup.ts')) {
  const [cmd, ...args] = process.argv.slice(2)
  
  const dedup = new QueryDedup({ verbose: true })
  
  async function main() {
    await dedup.init()

    switch (cmd) {
      case 'check': {
        const query = args.join(' ')
        if (!query) {
          console.log('Usage: query-dedup.ts check <query>')
          process.exit(1)
        }
        const result = await dedup.check(query)
        console.log(JSON.stringify(result, null, 2))
        break
      }

      case 'record': {
        const query = args.join(' ')
        if (!query) {
          console.log('Usage: query-dedup.ts record <query>')
          process.exit(1)
        }
        const success = await dedup.record(query)
        console.log(success ? 'Recorded' : 'Failed')
        break
      }

      case 'filter': {
        const queries = args[0] ? JSON.parse(args[0]) : []
        if (!Array.isArray(queries)) {
          console.log('Usage: query-dedup.ts filter \'["query1", "query2"]\'')
          process.exit(1)
        }
        const result = await dedup.filterNovel(queries)
        console.log(JSON.stringify(result, null, 2))
        break
      }

      case 'stats': {
        // Query table for stats
        const result = await lancedbQuery(TABLE_NAME, undefined, 10000)
        const records = result.records as unknown as QueryRecord[]
        
        const now = Date.now()
        const hourAgo = now - 60 * 60 * 1000
        const dayAgo = now - 24 * 60 * 60 * 1000
        
        console.log('Query Dedup Statistics:')
        console.log('=======================')
        console.log(`Total queries indexed: ${records.length}`)
        console.log(`Last hour: ${records.filter(r => r.timestamp > hourAgo).length}`)
        console.log(`Last 24h: ${records.filter(r => r.timestamp > dayAgo).length}`)
        
        // Category breakdown
        const byCategory = new Map<string, number>()
        for (const r of records) {
          const cat = r.category ?? 'uncategorized'
          byCategory.set(cat, (byCategory.get(cat) ?? 0) + 1)
        }
        console.log('\nBy category:')
        for (const [cat, count] of byCategory) {
          console.log(`  ${cat}: ${count}`)
        }
        break
      }

      default:
        console.log(`Query Dedup CLI — Vector-based query deduplication

Commands:
  check <query>              Check if query is a duplicate
  record <query>             Record a query as executed
  filter '<json array>'      Filter queries, return novel ones
  stats                      Show statistics

Examples:
  bun query-dedup.ts check "US stock market today"
  bun query-dedup.ts record "cryptocurrency bitcoin news"
  bun query-dedup.ts filter '["query1", "query2", "query3"]'
`)
    }
  }

  main().catch(console.error)
}

export default QueryDedup
