/**
 * trainingRAG.ts — RAG from past high-quality examples
 *
 * Before routing a query, retrieves similar successful interactions
 * from the training_examples LanceDB table and formats them as
 * few-shot context to improve response quality without retraining.
 *
 * Environment:
 *   LANCEDB_URI       — LanceDB REST API (default: http://lancedb-api:8000)
 *   OLLAMA_BASE_URL   — Ollama for embeddings (default: http://ollama:11434)
 *   EMBEDDING_MODEL   — embedding model (default: nomic-embed-text)
 *   RAG_ENABLED       — set to 'true' to enable (default: false)
 *   RAG_MIN_QUALITY   — minimum quality_score for retrieval (default: 0.7)
 *   RAG_TOP_K         — number of examples to retrieve (default: 3)
 *   RAG_CACHE_TTL_MS  — cache duration for RAG results (default: 60000)
 */

const LANCEDB_URI = process.env.LANCEDB_URI || 'http://lancedb-api:8000'
const OLLAMA_BASE_URL = process.env.OLLAMA_BASE_URL || 'http://ollama:11434'
const EMBEDDING_MODEL = process.env.EMBEDDING_MODEL || 'nomic-embed-text'
const DB = 'user_dbs'
const TABLE = 'training_examples'

const RAG_ENABLED = process.env.RAG_ENABLED === 'true'
const RAG_MIN_QUALITY = parseFloat(process.env.RAG_MIN_QUALITY || '0.7')
const RAG_TOP_K = parseInt(process.env.RAG_TOP_K || '3', 10)
const RAG_CACHE_TTL_MS = parseInt(process.env.RAG_CACHE_TTL_MS || '60000', 10)

export interface RAGExample {
  user: string
  assistant: string
  quality: number
  model: string
  tags: string
  distance: number
}

// Simple TTL cache: query hash → {examples, timestamp}
const ragCache = new Map<string, { examples: RAGExample[]; ts: number }>()

function hashQuery(q: string): string {
  // Simple FNV-1a hash for cache key
  let h = 0x811c9dc5
  for (let i = 0; i < q.length; i++) {
    h ^= q.charCodeAt(i)
    h = (h * 0x01000193) >>> 0
  }
  return h.toString(16)
}

async function getEmbedding(text: string): Promise<number[] | null> {
  try {
    const res = await fetch(`${OLLAMA_BASE_URL}/api/embed`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: EMBEDDING_MODEL, input: text.substring(0, 2000) }),
    })
    if (!res.ok) return null
    const data = await res.json() as { embeddings?: number[][] }
    return data.embeddings?.[0] ?? null
  } catch {
    return null
  }
}

/**
 * Retrieve high-quality past examples similar to the current query.
 * Returns empty array if RAG is disabled, LanceDB unreachable, or no matches.
 */
export async function retrieveSimilarExamples(userQuery: string): Promise<RAGExample[]> {
  if (!RAG_ENABLED) return []
  if (!userQuery || userQuery.length < 10) return []

  // Check cache
  const cacheKey = hashQuery(userQuery)
  const cached = ragCache.get(cacheKey)
  if (cached && Date.now() - cached.ts < RAG_CACHE_TTL_MS) {
    return cached.examples
  }

  try {
    // Generate embedding for the query
    const embedding = await getEmbedding(userQuery)
    if (!embedding) return []

    // Vector search in LanceDB
    const res = await fetch(`${LANCEDB_URI}/dbs/${DB}/tables/${TABLE}/query`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        vector: embedding,
        limit: RAG_TOP_K * 2, // fetch more to filter
        filter: `quality_score >= ${RAG_MIN_QUALITY} AND feedback != 'down'`,
        columns: ['user_content', 'assistant_content', 'quality_score', 'model_used', 'tags'],
      }),
      signal: AbortSignal.timeout(5000), // 5s timeout — don't block routing
    })

    if (!res.ok) return []

    const data = await res.json() as {
      records?: Array<{
        user_content: string
        assistant_content: string
        quality_score: number
        model_used: string
        tags: string
        _distance?: number
      }>
    }

    const records = data.records || []
    const examples: RAGExample[] = records
      .filter(r => r.user_content && r.assistant_content && r.user_content !== 'test')
      .slice(0, RAG_TOP_K)
      .map(r => ({
        user: r.user_content,
        assistant: r.assistant_content,
        quality: r.quality_score,
        model: r.model_used,
        tags: r.tags || '',
        distance: r._distance ?? 0,
      }))

    // Cache results
    ragCache.set(cacheKey, { examples, ts: Date.now() })

    // Evict old cache entries
    if (ragCache.size > 100) {
      const now = Date.now()
      for (const [key, val] of ragCache) {
        if (now - val.ts > RAG_CACHE_TTL_MS) ragCache.delete(key)
      }
    }

    return examples
  } catch {
    return [] // Never block on RAG failure
  }
}

/**
 * Format RAG examples as a few-shot prompt section.
 * Returns empty string if no examples available.
 */
export function formatRAGContext(examples: RAGExample[]): string {
  if (examples.length === 0) return ''

  const formattedExamples = examples.map((ex, i) => {
    const truncUser = ex.user.substring(0, 500)
    const truncAssistant = ex.assistant.substring(0, 1000)
    return `<example_${i + 1} quality="${ex.quality.toFixed(2)}">\nUser: ${truncUser}\nAssistant: ${truncAssistant}\n</example_${i + 1}>`
  }).join('\n\n')

  return `\n\n<similar_past_successes>\nHere are ${examples.length} similar past interactions that were rated highly. Use them as reference for tone, tool usage, and response quality:\n\n${formattedExamples}\n</similar_past_successes>\n`
}
