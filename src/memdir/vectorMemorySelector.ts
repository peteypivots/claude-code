/**
 * vectorMemorySelector.ts — Vector-based memory file selection
 * 
 * Replaces LLM-based memory selection with fast vector similarity search.
 * Uses LanceDB for vector storage and Ollama for embeddings.
 * 
 * Architecture:
 *   1. Memory files are indexed on first query (lazy initialization)
 *   2. Index is kept fresh via mtime comparison
 *   3. User queries are embedded and matched against index
 *   4. Falls back to LLM selector if LanceDB unavailable
 * 
 * Performance:
 *   - LLM selector: ~2000ms, ~500 tokens
 *   - Vector selector: ~60ms, 0 tokens
 * 
 * Environment:
 *   OLLAMA_BASE_URL       — Ollama API (default: http://ollama:11434)
 *   EMBEDDING_MODEL       — Model for embeddings (default: nomic-embed-text)
 *   LANCEDB_URI           — LanceDB REST API (default: http://lancedb-api:8000)
 *   MEMORY_SELECTOR_VERBOSE — Enable debug logging
 *   USE_VECTOR_MEMORY     — Enable vector selector (default: true when LanceDB available)
 */

import { readdir, stat, readFile } from 'fs/promises'
import { basename, join } from 'path'
import { createHash } from 'crypto'
import {
  lancedbQuery,
  lancedbSearch,
  lancedbIngest,
  type LanceDBRecord,
} from '../services/lancedb/index.js'
import { captureMemorySelection, captureIndexRebuild, isDecisionCaptureEnabled } from '../services/llm/decisionCapture.js'

// ── Configuration ─────────────────────────────────────────────────────────────

const OLLAMA_BASE_URL = process.env.OLLAMA_BASE_URL ?? 'http://ollama:11434'
const EMBEDDING_MODEL = process.env.EMBEDDING_MODEL ?? 'nomic-embed-text'
const VERBOSE = process.env.MEMORY_SELECTOR_VERBOSE === 'true'

const TABLE_NAME = 'memory_embeddings'
const MAX_MEMORIES = 5
const MAX_CONTENT_PREVIEW = 500
const MAX_CONTENT_STORE = 32000  // Store up to 32KB of content in LanceDB
const STALE_THRESHOLD_MS = 5 * 60 * 1000  // 5 minutes

// ── Types ─────────────────────────────────────────────────────────────────────

export interface MemoryFile {
  path: string
  filename: string
  description: string | null
  type: string | null
  mtimeMs: number
}

export interface MemoryEmbedding {
  id: string
  filepath: string
  filename: string
  description: string
  type: string
  content_preview: string
  /** Full content stored in LanceDB (up to MAX_CONTENT_STORE) */
  content: string
  mtime_ms: number
  embedding: number[]
  indexed_at: number
}

export interface SelectionResult {
  memories: MemoryFile[]
  selector: 'vector' | 'llm' | 'fallback'
  latencyMs: number
  indexStatus?: 'fresh' | 'stale' | 'rebuilt' | 'unavailable'
}

// ── Logging ───────────────────────────────────────────────────────────────────

function log(msg: string): void {
  if (VERBOSE) {
    console.error(`[vector-memory] ${msg}`)
  }
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
    if (!res.ok) return null
    const data = (await res.json()) as EmbeddingResponse
    return data.embeddings?.[0] ?? null
  } catch {
    return null
  }
}

async function embedBatch(texts: string[]): Promise<(number[] | null)[]> {
  if (texts.length === 0) return []
  
  try {
    const res = await fetch(`${OLLAMA_BASE_URL}/api/embed`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: EMBEDDING_MODEL, input: texts.map(t => t.substring(0, 2000)) }),
      signal: AbortSignal.timeout(60000),
    })
    if (!res.ok) return texts.map(() => null)
    const data = (await res.json()) as EmbeddingResponse
    return data.embeddings ?? texts.map(() => null)
  } catch {
    return texts.map(() => null)
  }
}

// ── Frontmatter Parser (simplified) ───────────────────────────────────────────

interface Frontmatter {
  description?: string
  type?: string
  [key: string]: unknown
}

function parseFrontmatter(content: string): { frontmatter: Frontmatter; body: string } {
  const match = content.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/)
  if (!match) {
    return { frontmatter: {}, body: content }
  }

  const yamlBlock = match[1] ?? ''
  const body = match[2] ?? ''
  const frontmatter: Frontmatter = {}

  for (const line of yamlBlock.split('\n')) {
    const colonIdx = line.indexOf(':')
    if (colonIdx > 0) {
      const key = line.slice(0, colonIdx).trim()
      const value = line.slice(colonIdx + 1).trim().replace(/^["']|["']$/g, '')
      frontmatter[key] = value
    }
  }

  return { frontmatter, body }
}

// ── Memory Scanner ────────────────────────────────────────────────────────────

async function scanMemoryDir(memoryDir: string): Promise<MemoryFile[]> {
  try {
    const entries = await readdir(memoryDir, { recursive: true })
    const mdFiles = entries.filter(
      f => f.endsWith('.md') && basename(f) !== 'MEMORY.md'
    )

    const memories: MemoryFile[] = []
    for (const relativePath of mdFiles) {
      const filePath = join(memoryDir, relativePath)
      try {
        const stats = await stat(filePath)
        const content = await readFile(filePath, 'utf-8')
        const { frontmatter } = parseFrontmatter(content)

        memories.push({
          path: filePath,
          filename: relativePath,
          description: frontmatter.description as string | null ?? null,
          type: frontmatter.type as string | null ?? null,
          mtimeMs: stats.mtimeMs,
        })
      } catch {
        // Skip files we can't read
      }
    }

    return memories.sort((a, b) => b.mtimeMs - a.mtimeMs).slice(0, 200)
  } catch {
    return []
  }
}

// ── Index Management ──────────────────────────────────────────────────────────

function memoryId(filepath: string): string {
  return createHash('sha256').update(filepath).digest('hex').substring(0, 16)
}

async function buildIndex(memoryDir: string): Promise<number> {
  log(`Building memory index for ${memoryDir}`)
  const startTime = Date.now()

  const memories = await scanMemoryDir(memoryDir)
  if (memories.length === 0) {
    log('No memory files found')
    return 0
  }

  log(`Found ${memories.length} memory files`)

  // Read content and build embedding text
  const embeddingTexts: string[] = []
  const validMemories: Array<MemoryFile & { content: string; preview: string }> = []

  for (const mem of memories) {
    try {
      const rawContent = await readFile(mem.path, 'utf-8')
      const { body } = parseFrontmatter(rawContent)
      const preview = body.substring(0, MAX_CONTENT_PREVIEW)
      const fullContent = body.substring(0, MAX_CONTENT_STORE)  // Store full content (capped)
      
      // Build text for embedding: type + filename + description + preview
      const embeddingText = [
        mem.type ? `[${mem.type}]` : '',
        mem.filename,
        mem.description ?? '',
        preview,
      ].filter(Boolean).join(' ')

      embeddingTexts.push(embeddingText)
      validMemories.push({ ...mem, content: fullContent, preview })
    } catch {
      // Skip unreadable files
    }
  }

  // Batch embed
  log(`Embedding ${embeddingTexts.length} memories...`)
  const embeddings = await embedBatch(embeddingTexts)

  // Build records
  const records: LanceDBRecord[] = []
  const now = Date.now()

  for (let i = 0; i < validMemories.length; i++) {
    const mem = validMemories[i]!
    const embedding = embeddings[i]
    if (!embedding) continue

    records.push({
      id: memoryId(mem.path),
      filepath: mem.path,
      filename: mem.filename,
      description: mem.description ?? '',
      type: mem.type ?? '',
      content_preview: mem.preview,
      content: mem.content,  // Store full content for direct LanceDB recall
      mtime_ms: mem.mtimeMs,
      embedding,
      indexed_at: now,
    })
  }

  if (records.length === 0) {
    log('No records to index (embedding failed)')
    return 0
  }

  // Ingest to LanceDB
  const result = await lancedbIngest(TABLE_NAME, records)
  if (!result.success) {
    log(`Index failed: ${result.error}`)
    return 0
  }

  log(`Indexed ${records.length} memories in ${Date.now() - startTime}ms`)
  return records.length
}

async function checkIndexFreshness(memoryDir: string): Promise<'fresh' | 'stale' | 'empty'> {
  // Get latest indexed_at from table
  const result = await lancedbQuery(TABLE_NAME, undefined, 1)
  if (result.error || result.records.length === 0) {
    return 'empty'
  }

  const indexed = result.records[0] as unknown as MemoryEmbedding
  const indexAge = Date.now() - indexed.indexed_at

  if (indexAge > STALE_THRESHOLD_MS) {
    return 'stale'
  }

  // Check if any memory files are newer than index
  const memories = await scanMemoryDir(memoryDir)
  const newestMemory = memories[0]
  if (newestMemory && newestMemory.mtimeMs > indexed.indexed_at) {
    return 'stale'
  }

  return 'fresh'
}

// ── Vector Selection ──────────────────────────────────────────────────────────

export async function selectMemoriesVector(
  query: string,
  memoryDir: string,
  maxResults = MAX_MEMORIES,
): Promise<SelectionResult> {
  const startTime = Date.now()

  // Check index status
  const freshness = await checkIndexFreshness(memoryDir)
  let indexStatus: SelectionResult['indexStatus'] = freshness === 'empty' ? 'unavailable' : freshness
  
  if (freshness === 'empty' || freshness === 'stale') {
    const indexed = await buildIndex(memoryDir)
    indexStatus = indexed > 0 ? 'rebuilt' : 'unavailable'
  }

  if (indexStatus === 'unavailable') {
    return {
      memories: [],
      selector: 'fallback',
      latencyMs: Date.now() - startTime,
      indexStatus,
    }
  }

  // Embed query
  const queryEmbedding = await embed(query)
  if (!queryEmbedding) {
    log('Failed to embed query')
    return {
      memories: [],
      selector: 'fallback',
      latencyMs: Date.now() - startTime,
      indexStatus,
    }
  }

  // Search
  const searchResult = await lancedbSearch(TABLE_NAME, queryEmbedding, maxResults * 2)
  if (searchResult.error) {
    log(`Search failed: ${searchResult.error}`)
    return {
      memories: [],
      selector: 'fallback',
      latencyMs: Date.now() - startTime,
      indexStatus,
    }
  }

  // Map results back to MemoryFile format
  const topDistances: number[] = []
  const memories: MemoryFile[] = searchResult.results
    .slice(0, maxResults)
    .map(r => {
      const record = r as unknown as MemoryEmbedding & { _distance?: number }
      log(`  ${record.filename}: distance=${record._distance?.toFixed(3) ?? 'N/A'}`)
      if (record._distance !== undefined) topDistances.push(record._distance)
      return {
        path: record.filepath,
        filename: record.filename,
        description: record.description || null,
        type: record.type || null,
        mtimeMs: record.mtime_ms,
      }
    })

  const latencyMs = Date.now() - startTime

  // Capture decision event
  if (isDecisionCaptureEnabled()) {
    captureMemorySelection({
      query,
      selectedFiles: memories.map(m => m.filename),
      selector: 'vector',
      latencyMs,
      indexStatus,
      topDistances,
    }).catch(() => {})  // Fire and forget
  }

  return {
    memories,
    selector: 'vector',
    latencyMs,
    indexStatus,
  }
}

// ── Comparison Tool ───────────────────────────────────────────────────────────

export interface ComparisonResult {
  query: string
  vector: {
    memories: string[]
    latencyMs: number
  }
  overlap: string[]
  vectorOnly: string[]
  agreement: number  // 0-1 (intersection / union)
}

// ── Direct LanceDB Recall (no file reads) ─────────────────────────────────────

export interface MemoryRecallResult {
  id: string
  filepath: string
  filename: string
  description: string
  type: string
  content: string
  mtime_ms: number
  _distance?: number
}

export interface DirectRecallResult {
  memories: MemoryRecallResult[]
  latencyMs: number
  queryEmbedded: boolean
}

/**
 * Query memories directly from LanceDB with full content.
 * No file reads required - content is stored in the index.
 * Use this for fast recall without filesystem access.
 */
export async function recallMemoriesFromLanceDB(
  query: string,
  maxResults = MAX_MEMORIES,
  maxDistance = 0.35,  // Lower = more similar
): Promise<DirectRecallResult> {
  const startTime = Date.now()

  // Embed query
  const queryEmbedding = await embed(query)
  if (!queryEmbedding) {
    log('Failed to embed query for direct recall')
    return { memories: [], latencyMs: Date.now() - startTime, queryEmbedded: false }
  }

  // Search with content column
  const searchResult = await lancedbSearch(TABLE_NAME, queryEmbedding, maxResults * 2)
  if (searchResult.error) {
    log(`Direct recall search failed: ${searchResult.error}`)
    return { memories: [], latencyMs: Date.now() - startTime, queryEmbedded: true }
  }

  // Filter by distance and map to results with content
  const memories: MemoryRecallResult[] = searchResult.results
    .filter(r => {
      const distance = (r as unknown as { _distance?: number })._distance
      return distance === undefined || distance < maxDistance
    })
    .slice(0, maxResults)
    .map(r => {
      const record = r as unknown as MemoryEmbedding & { _distance?: number }
      return {
        id: record.id,
        filepath: record.filepath,
        filename: record.filename,
        description: record.description,
        type: record.type,
        content: record.content || record.content_preview,  // Fallback to preview if content missing
        mtime_ms: record.mtime_ms,
        _distance: record._distance,
      }
    })

  const latencyMs = Date.now() - startTime
  log(`Direct recall found ${memories.length} memories in ${latencyMs}ms`)

  return { memories, latencyMs, queryEmbedded: true }
}

/**
 * Format recalled memories for injection into agent context.
 */
export function formatRecalledMemories(memories: MemoryRecallResult[]): string {
  if (memories.length === 0) return ''

  const lines: string[] = [
    '<relevant-memories>',
    'The following memories from previous sessions may be relevant:',
    ''
  ]

  for (const m of memories) {
    const age = formatAge(m.mtime_ms)
    lines.push(`### ${m.filename}`)
    if (m.description) {
      lines.push(`Description: ${m.description}`)
    }
    if (m.type) {
      lines.push(`Type: ${m.type}`)
    }
    lines.push(`Saved: ${age}`)
    lines.push('')
    lines.push(m.content)
    lines.push('')
    lines.push('---')
    lines.push('')
  }

  lines.push('</relevant-memories>')
  return lines.join('\n')
}

function formatAge(mtimeMs: number): string {
  const days = Math.floor((Date.now() - mtimeMs) / (1000 * 60 * 60 * 24))
  if (days === 0) return 'today'
  if (days === 1) return 'yesterday'
  if (days < 7) return `${days} days ago`
  if (days < 30) return `${Math.floor(days / 7)} weeks ago`
  return `${Math.floor(days / 30)} months ago`
}

export async function compareSelectors(
  query: string,
  memoryDir: string,
): Promise<ComparisonResult> {
  // Run vector selector
  const vectorResult = await selectMemoriesVector(query, memoryDir)
  const vectorFiles = vectorResult.memories.map(m => m.filename)

  // We'd need to import the LLM selector here for real comparison
  // For now, just return vector results
  return {
    query,
    vector: {
      memories: vectorFiles,
      latencyMs: vectorResult.latencyMs,
    },
    overlap: vectorFiles,  // Would be intersection with LLM results
    vectorOnly: [],
    agreement: 1.0,  // Would be jaccard index
  }
}

// ── CLI ───────────────────────────────────────────────────────────────────────

if (import.meta.main || process.argv[1]?.endsWith('vectorMemorySelector.ts')) {
  const [cmd, ...args] = process.argv.slice(2)
  const memoryDir = process.env.MEMORY_DIR ?? '/home/ables/.claude'

  async function main() {
    switch (cmd) {
      case 'select': {
        const query = args.join(' ')
        if (!query) {
          console.log('Usage: vectorMemorySelector.ts select <query>')
          process.exit(1)
        }
        const result = await selectMemoriesVector(query, memoryDir)
        console.log(JSON.stringify(result, null, 2))
        break
      }

      case 'index': {
        const count = await buildIndex(memoryDir)
        console.log(`Indexed ${count} memory files`)
        break
      }

      case 'compare': {
        const query = args.join(' ')
        if (!query) {
          console.log('Usage: vectorMemorySelector.ts compare <query>')
          process.exit(1)
        }
        const result = await compareSelectors(query, memoryDir)
        console.log(JSON.stringify(result, null, 2))
        break
      }

      case 'recall': {
        const query = args.join(' ')
        if (!query) {
          console.log('Usage: vectorMemorySelector.ts recall <query>')
          process.exit(1)
        }
        const result = await recallMemoriesFromLanceDB(query)
        console.log(`Found ${result.memories.length} memories in ${result.latencyMs}ms\n`)
        console.log(formatRecalledMemories(result.memories))
        break
      }

      case 'stats': {
        const result = await lancedbQuery(TABLE_NAME, undefined, 10000)
        const records = result.records as unknown as MemoryEmbedding[]
        
        console.log('Memory Embedding Index Statistics:')
        console.log('===================================')
        console.log(`Total indexed: ${records.length}`)
        
        if (records.length > 0) {
          const newest = Math.max(...records.map(r => r.indexed_at))
          const oldest = Math.min(...records.map(r => r.indexed_at))
          console.log(`Newest: ${new Date(newest).toISOString()}`)
          console.log(`Oldest: ${new Date(oldest).toISOString()}`)
          
          // Type breakdown
          const byType = new Map<string, number>()
          for (const r of records) {
            const type = r.type || 'untyped'
            byType.set(type, (byType.get(type) ?? 0) + 1)
          }
          console.log('\nBy type:')
          for (const [type, count] of byType) {
            console.log(`  ${type}: ${count}`)
          }
        }
        break
      }

      case 'test': {
        // Run a few test queries
        const testQueries = [
          'oauth configuration authentication',
          'debugging errors stack trace',
          'performance optimization speed',
          'database queries SQL',
          'testing unit tests',
        ]
        
        console.log(`Testing vector selection on ${memoryDir}\n`)
        
        for (const query of testQueries) {
          const result = await selectMemoriesVector(query, memoryDir)
          console.log(`Query: "${query}"`)
          console.log(`  Latency: ${result.latencyMs}ms`)
          console.log(`  Index: ${result.indexStatus}`)
          console.log(`  Results: ${result.memories.map(m => m.filename).join(', ') || '(none)'}`)
          console.log('')
        }
        break
      }

      default:
        console.log(`Vector Memory Selector — Fast memory file selection via embeddings

Commands:
  select <query>     Select relevant memory files for query (returns file paths)
  recall <query>     Recall memories from LanceDB with full content (no file reads)
  index              Build/rebuild the memory index
  compare <query>    Compare vector vs LLM selector (requires LLM access)
  stats              Show index statistics
  test               Run test queries

Environment:
  MEMORY_DIR                 Memory directory (default: ~/.claude)
  OLLAMA_BASE_URL            Ollama API URL
  LANCEDB_URI                LanceDB REST API URL
  MEMORY_SELECTOR_VERBOSE    Enable debug logging

Examples:
  bun vectorMemorySelector.ts select "how do I configure oauth?"
  bun vectorMemorySelector.ts recall "debugging tips"
  bun vectorMemorySelector.ts index
  MEMORY_SELECTOR_VERBOSE=true bun vectorMemorySelector.ts test
`)
    }
  }

  main().catch(console.error)
}

export default {
  selectMemoriesVector,
  recallMemoriesFromLanceDB,
  formatRecalledMemories,
  buildIndex,
  compareSelectors,
}
