#!/usr/bin/env bun
/**
 * export-dataset.ts — Export filtered training data from LanceDB
 *
 * Queries LanceDB training tables and exports formatted datasets
 * for SFT, DPO, or routing classifier training.
 *
 * Usage:
 *   bun run scripts/export-dataset.ts --format sft --output training.jsonl
 *   bun run scripts/export-dataset.ts --format sft --feedback up --min-quality 0.8
 *   bun run scripts/export-dataset.ts --format dpo --output dpo.jsonl
 *   bun run scripts/export-dataset.ts --format routing --output routing.jsonl
 *   bun run scripts/export-dataset.ts --format sft --tags tool_use --model qwen2.5:7b
 *
 * Environment:
 *   LANCEDB_URI  — LanceDB REST API (default: http://lancedb-api:8000)
 */

import { writeFileSync } from 'fs'

// ── Config ────────────────────────────────────────────────
const LANCEDB_URI = process.env.LANCEDB_URI || 'http://lancedb-api:8000'
const DB = 'user_dbs'

// ── Parse CLI args ────────────────────────────────────────
function getArg(name: string): string | undefined {
  const idx = process.argv.indexOf(`--${name}`)
  return idx >= 0 ? process.argv[idx + 1] : undefined
}

const format = getArg('format') || 'sft'
const output = getArg('output') || `training-${format}-${Date.now()}.jsonl`
const feedbackFilter = getArg('feedback') // 'up' | 'down'
const minQuality = parseFloat(getArg('min-quality') || '0')
const maxQuality = parseFloat(getArg('max-quality') || '1')
const tagsFilter = getArg('tags') // comma-separated
const modelFilter = getArg('model')
const limit = parseInt(getArg('limit') || '10000', 10)

// ── LanceDB query helper ─────────────────────────────────
async function queryTable(
  table: string,
  filter?: string,
  queryLimit = limit,
): Promise<Record<string, unknown>[]> {
  try {
    const body: Record<string, unknown> = { limit: queryLimit }
    if (filter) body.filter = filter
    const res = await fetch(`${LANCEDB_URI}/dbs/${DB}/tables/${table}/query`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
    const data = await res.json() as { records?: Record<string, unknown>[] }
    return data.records || []
  } catch (e) {
    console.error(`Query failed for ${table}: ${e}`)
    return []
  }
}

// ── Build filter string ───────────────────────────────────
function buildFilter(): string {
  const conditions: string[] = []
  if (feedbackFilter) {
    conditions.push(`feedback = '${feedbackFilter}'`)
  }
  if (minQuality > 0) {
    conditions.push(`quality_score >= ${minQuality}`)
  }
  if (maxQuality < 1) {
    conditions.push(`quality_score <= ${maxQuality}`)
  }
  if (modelFilter) {
    conditions.push(`model_used = '${modelFilter}'`)
  }
  // Note: tags is stored as comma-separated string, use LIKE for filtering
  if (tagsFilter) {
    for (const tag of tagsFilter.split(',')) {
      conditions.push(`tags LIKE '%${tag.trim()}%'`)
    }
  }
  return conditions.join(' AND ')
}

// ── Format: SFT ───────────────────────────────────────────
interface SFTExample {
  messages: Array<{ role: string; content: string }>
}

function toSFT(record: Record<string, unknown>): SFTExample {
  const messages: Array<{ role: string; content: string }> = []
  const system = record.system_prompt as string
  if (system && system.length > 10) {
    messages.push({ role: 'system', content: system })
  }
  messages.push({ role: 'user', content: record.user_content as string })
  messages.push({ role: 'assistant', content: record.assistant_content as string })
  return { messages }
}

// ── Format: DPO ───────────────────────────────────────────
interface DPOExample {
  prompt: string
  chosen: string
  rejected: string
}

async function exportDPO(): Promise<DPOExample[]> {
  // Get high-quality examples (chosen)
  const chosen = await queryTable(
    'training_examples',
    `quality_score >= 0.8${feedbackFilter === 'up' ? " AND feedback = 'up'" : ''}`,
  )
  // Get low-quality examples (rejected)
  const rejected = await queryTable(
    'training_examples',
    `quality_score <= 0.5${feedbackFilter === 'down' ? " AND feedback = 'down'" : ''}`,
  )

  if (chosen.length === 0 || rejected.length === 0) {
    console.warn('Not enough data for DPO pairs. Need both high and low quality examples.')
    return []
  }

  const pairs: DPOExample[] = []

  // Pair by similar canonical_prompt
  for (const c of chosen) {
    const cCanonical = c.canonical_prompt as string
    // Find a rejected example with similar prompt
    const match = rejected.find(r => {
      const rCanonical = r.canonical_prompt as string
      // Simple similarity: shared word ratio
      const cWords = new Set(cCanonical.split(' '))
      const rWords = new Set(rCanonical.split(' '))
      const intersection = [...cWords].filter(w => rWords.has(w)).length
      const union = new Set([...cWords, ...rWords]).size
      return union > 0 && intersection / union > 0.5
    })

    if (match) {
      pairs.push({
        prompt: c.user_content as string,
        chosen: c.assistant_content as string,
        rejected: match.assistant_content as string,
      })
    }
  }

  return pairs
}

// ── Format: Routing Classifier ────────────────────────────
interface RoutingExample {
  input: string
  label: string
  features: {
    tool_count: number
    conversation_depth: number
    confidence: number
    latency_ms: number
  }
}

async function exportRouting(): Promise<RoutingExample[]> {
  const records = await queryTable('routing_decisions')
  return records.map(r => ({
    input: r.input_summary as string,
    label: r.decision as string,
    features: {
      tool_count: r.tool_count as number,
      conversation_depth: r.conversation_depth as number,
      confidence: r.confidence as number,
      latency_ms: r.latency_ms as number,
    },
  }))
}

// ── Format: Query Rephrase (for training query expansion) ────────
interface RephraseExample {
  original_query: string
  alternative_query: string
  reason: string
  success?: boolean
}

async function exportRephrase(): Promise<RephraseExample[]> {
  const records = await queryTable(
    'training_examples',
    "tags LIKE '%query_rephrase%'",
  )
  
  return records.map(r => {
    const canonical = r.canonical_prompt as string
    try {
      const parsed = JSON.parse(canonical)
      return {
        original_query: parsed.original || r.user_content as string,
        alternative_query: parsed.alternative || r.assistant_content as string,
        reason: parsed.reason || 'duplicate_results',
        success: parsed.alternativeSuccess,
      }
    } catch {
      return {
        original_query: r.user_content as string,
        alternative_query: r.assistant_content as string,
        reason: 'duplicate_results',
      }
    }
  })
}

// ── Format: External API Calls (for API usage analysis) ──────────
interface ExternalAPIExample {
  provider: string
  endpoint: string
  request: string
  response: string
  latency_ms: number
  rate_limited: boolean
}

async function exportExternalAPI(): Promise<ExternalAPIExample[]> {
  const records = await queryTable(
    'training_examples',
    "tags LIKE '%external_api%'",
  )
  
  return records.map(r => {
    const canonical = r.canonical_prompt as string
    try {
      const parsed = JSON.parse(canonical)
      return {
        provider: parsed.provider || r.model_used as string,
        endpoint: parsed.endpoint || 'unknown',
        request: parsed.request || r.user_content as string,
        response: parsed.response || r.assistant_content as string,
        latency_ms: r.latency_ms as number || 0,
        rate_limited: parsed.rateLimited ?? false,
      }
    } catch {
      return {
        provider: r.model_used as string,
        endpoint: 'unknown',
        request: r.user_content as string,
        response: r.assistant_content as string,
        latency_ms: r.latency_ms as number || 0,
        rate_limited: false,
      }
    }
  })
}

// ── Main ──────────────────────────────────────────────────
async function main() {
  console.log(`=== Export Training Data ===`)
  console.log(`  Format:      ${format}`)
  console.log(`  Output:      ${output}`)
  console.log(`  LanceDB:     ${LANCEDB_URI}`)
  if (feedbackFilter) console.log(`  Feedback:    ${feedbackFilter}`)
  if (minQuality > 0) console.log(`  Min quality: ${minQuality}`)
  if (tagsFilter) console.log(`  Tags:        ${tagsFilter}`)
  if (modelFilter) console.log(`  Model:       ${modelFilter}`)
  console.log('')

  let results: unknown[] = []

  switch (format) {
    case 'sft': {
      const filter = buildFilter()
      console.log(`  Filter: ${filter || '(none)'}`)
      const records = await queryTable('training_examples', filter || undefined)
      results = records.map(toSFT)
      break
    }
    case 'dpo': {
      results = await exportDPO()
      break
    }
    case 'routing': {
      results = await exportRouting()
      break
    }
    case 'rephrase': {
      results = await exportRephrase()
      break
    }
    case 'api':
    case 'external': {
      results = await exportExternalAPI()
      break
    }
    default:
      console.error(`Unknown format: ${format}. Use: sft, dpo, routing, rephrase, api`)
      process.exit(1)
  }

  if (results.length === 0) {
    console.log('No records matched the filters.')
    return
  }

  // Write JSONL
  const lines = results.map(r => JSON.stringify(r)).join('\n') + '\n'
  writeFileSync(output, lines)
  console.log(`\nExported ${results.length} examples to ${output}`)

  // Print sample
  console.log('\nSample (first record):')
  console.log(JSON.stringify(results[0], null, 2).substring(0, 500))
}

main().catch(e => {
  console.error('Export failed:', e)
  process.exit(1)
})
