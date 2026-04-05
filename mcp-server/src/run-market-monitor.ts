#!/usr/bin/env bun
/**
 * run-market-monitor.ts — TypeScript Market Monitor Runner
 * 
 * Runs continuous market research cycles using:
 * - LLM agents for query execution
 * - Grok for query rephrasing (with rate limit tracking)
 * - LanceDB for storage
 * - trainingCapture.ts for training data
 * 
 * Usage:
 *   bun run-market-monitor.ts                  # Run forever
 *   bun run-market-monitor.ts --cycles 5       # Run 5 cycles
 *   bun run-market-monitor.ts --delay 300      # 5 min between cycles
 *   bun run-market-monitor.ts --queries 8      # 8 queries per cycle
 *   
 * Environment:
 *   INSTANCE              - Instance name for multiple monitors (default: default)
 *   CYCLE_DELAY           - Seconds between cycles (default: 300)
 *   QUERIES_PER_CYCLE     - Queries per cycle (default: 8)
 *   GROK_REPHRASE_ENABLED - Enable Grok query refinement (default: true)
 *   TRAINING_CAPTURE      - Enable training data capture (default: false)
 */

import { spawn } from 'child_process'
import { existsSync, readFileSync, appendFileSync, writeFileSync } from 'fs'
import {
  grokBatchRephrase,
  grokChat,
  getGrokRateLimitState,
  isGrokAvailable,
  getAndClearQueuedQueries,
  type GrokRateLimitState,
} from './nitter-client.js'
import {
  captureExternalAPICall,
  captureQueryRephrase,
  captureBatchRephrase,
  getCaptureStats,
  isCaptureEnabled,
} from '../../src/services/llm/trainingCapture.js'

// ── CLI Args ──────────────────────────────────────────────────────────────────

const args = process.argv.slice(2)
const getArg = (name: string, def: string): string => {
  const idx = args.indexOf(`--${name}`)
  return idx >= 0 && args[idx + 1] ? args[idx + 1]! : def
}

const INSTANCE = process.env.INSTANCE ?? 'default'
const MAX_CYCLES = parseInt(getArg('cycles', '0'), 10) // 0 = infinite
const CYCLE_DELAY_SEC = parseInt(getArg('delay', process.env.CYCLE_DELAY ?? '300'), 10)
const QUERIES_PER_CYCLE = parseInt(getArg('queries', process.env.QUERIES_PER_CYCLE ?? '8'), 10)
const GROK_ENABLED = (process.env.GROK_REPHRASE_ENABLED ?? 'true') === 'true'

// ── Paths ─────────────────────────────────────────────────────────────────────

const LOG_FILE = `/tmp/agent-monitor-${INSTANCE}.log`
const DUPE_QUEUE_FILE = `/tmp/agent-monitor-${INSTANCE}-dupe-queue.json`
const ALTERNATIVES_CACHE_FILE = `/tmp/agent-monitor-${INSTANCE}-alternatives.json`
const RATE_LIMIT_FILE = `/tmp/agent-monitor-${INSTANCE}-rate-limit.json`

// ── State ─────────────────────────────────────────────────────────────────────

interface CycleStats {
  cycle: number
  queriesRun: number
  stored: number
  duplicates: number
  errors: number
  grokCalls: number
  grokRateLimited: number
  startTime: number
  endTime?: number
}

interface DupeQueue {
  queries: string[]
  addedAt: number
}

interface AlternativesCache {
  alternatives: Record<string, string>
  updatedAt: number
}

// ── Logging ───────────────────────────────────────────────────────────────────

function log(message: string, level: 'info' | 'warn' | 'error' = 'info'): void {
  const timestamp = new Date().toISOString()
  const prefix = level === 'error' ? '❌' : level === 'warn' ? '⚠️' : '📊'
  const line = `[${timestamp}] ${prefix} ${message}\n`
  appendFileSync(LOG_FILE, line)
  console.log(line.trim())
}

// ── Persistence ───────────────────────────────────────────────────────────────

function loadDupeQueue(): DupeQueue {
  if (existsSync(DUPE_QUEUE_FILE)) {
    try {
      return JSON.parse(readFileSync(DUPE_QUEUE_FILE, 'utf-8'))
    } catch {
      return { queries: [], addedAt: Date.now() }
    }
  }
  return { queries: [], addedAt: Date.now() }
}

function saveDupeQueue(queue: DupeQueue): void {
  writeFileSync(DUPE_QUEUE_FILE, JSON.stringify(queue, null, 2))
}

function loadAlternativesCache(): AlternativesCache {
  if (existsSync(ALTERNATIVES_CACHE_FILE)) {
    try {
      return JSON.parse(readFileSync(ALTERNATIVES_CACHE_FILE, 'utf-8'))
    } catch {
      return { alternatives: {}, updatedAt: Date.now() }
    }
  }
  return { alternatives: {}, updatedAt: Date.now() }
}

function saveAlternativesCache(cache: AlternativesCache): void {
  writeFileSync(ALTERNATIVES_CACHE_FILE, JSON.stringify(cache, null, 2))
}

function saveRateLimitState(state: GrokRateLimitState): void {
  writeFileSync(RATE_LIMIT_FILE, JSON.stringify(state, null, 2))
}

// ── Query Management ──────────────────────────────────────────────────────────

const DEFAULT_QUERIES = [
  'US stock market today S&P 500 Dow NASDAQ',
  'bond yields treasury 10Y 2Y curve',
  'VIX volatility index options market',
  'Federal Reserve interest rate FOMC decision',
  'inflation CPI PPI consumer prices',
  'tech stocks NASDAQ mega-cap FAANG',
  'cryptocurrency bitcoin ethereum DeFi',
  'gold silver commodities metals',
  'oil prices OPEC crude energy',
  'China trade tariffs supply chain',
  'geopolitical risk war sanctions markets',
  'dollar index DXY forex currency',
]

function pickQueries(count: number): string[] {
  const shuffled = [...DEFAULT_QUERIES].sort(() => Math.random() - 0.5)
  const timeModifier = new Date().getUTCHours() < 14 ? 'today' : 'today latest'
  return shuffled.slice(0, count).map(q => `${q} ${timeModifier}`)
}

// ── Pipeline Execution ────────────────────────────────────────────────────────

interface PipelineResult {
  stored: number
  duplicates: number
  error?: string
}

async function runPipeline(query: string): Promise<PipelineResult> {
  return new Promise((resolve) => {
    const proc = spawn('bash', [
      '/app/.claude/skills/web-research/scripts/research-pipeline.sh',
      query,
    ], { timeout: 60000 })

    let output = ''
    proc.stdout?.on('data', (data) => { output += data.toString() })
    proc.stderr?.on('data', (data) => { output += data.toString() })

    proc.on('close', (code) => {
      const stored = (output.match(/STORED/g) || []).length
      const duplicates = (output.match(/DUPLICATE/g) || []).length
      resolve({ stored, duplicates, error: code !== 0 ? `Exit code ${code}` : undefined })
    })

    proc.on('error', (err) => {
      resolve({ stored: 0, duplicates: 0, error: err.message })
    })
  })
}

// ── Grok Integration ──────────────────────────────────────────────────────────

async function processGrokQueue(): Promise<{
  processed: number
  alternatives: Record<string, string>
  rateLimited: boolean
}> {
  if (!GROK_ENABLED) {
    return { processed: 0, alternatives: {}, rateLimited: false }
  }

  // Load queued queries
  const queue = loadDupeQueue()
  if (queue.queries.length === 0) {
    return { processed: 0, alternatives: {}, rateLimited: false }
  }

  // Check rate limit
  if (!isGrokAvailable()) {
    const state = getGrokRateLimitState()
    log(`Grok rate limited. ${state.estimatedResetSecs}s until reset. ${queue.queries.length} queries queued.`, 'warn')
    saveRateLimitState(state)
    return { processed: 0, alternatives: {}, rateLimited: true }
  }

  log(`Processing ${queue.queries.length} queued queries via Grok batch...`)
  const startTime = Date.now()

  // Batch call
  const result = await grokBatchRephrase(queue.queries, { queueIfRateLimited: true })
  const latencyMs = Date.now() - startTime

  // Save rate limit state
  if (result.rateLimit) {
    saveRateLimitState(result.rateLimit)
  }

  // Capture for training
  if (isCaptureEnabled() && Object.keys(result.alternatives).length > 0) {
    await captureExternalAPICall({
      provider: 'grok',
      endpoint: 'batch_rephrase',
      request: JSON.stringify(queue.queries),
      response: JSON.stringify(result.alternatives),
      latencyMs,
      rateLimited: result.rateLimited,
      rateLimitState: result.rateLimit ? {
        totalCalls: result.rateLimit.totalCalls,
        rateLimitHits: result.rateLimit.rateLimitHits,
        estimatedResetSecs: result.rateLimit.estimatedResetSecs,
      } : undefined,
      tags: ['market_monitor', 'batch_rephrase'],
    })

    // Capture individual rephrase examples
    await captureBatchRephrase(result.alternatives, 'duplicate_results')
  }

  // Update alternatives cache
  if (Object.keys(result.alternatives).length > 0) {
    const cache = loadAlternativesCache()
    cache.alternatives = { ...cache.alternatives, ...result.alternatives }
    cache.updatedAt = Date.now()
    saveAlternativesCache(cache)
    log(`Grok returned ${Object.keys(result.alternatives).length} alternatives`)
  }

  // Clear processed queries from queue
  if (!result.rateLimited) {
    saveDupeQueue({ queries: [], addedAt: Date.now() })
  }

  return {
    processed: Object.keys(result.alternatives).length,
    alternatives: result.alternatives,
    rateLimited: result.rateLimited ?? false,
  }
}

function queueDuplicateQuery(query: string): void {
  const queue = loadDupeQueue()
  if (!queue.queries.includes(query)) {
    queue.queries.push(query)
    saveDupeQueue(queue)
  }
}

function getCachedAlternative(query: string): string | undefined {
  const cache = loadAlternativesCache()
  return cache.alternatives[query]
}

// ── Cycle Execution ───────────────────────────────────────────────────────────

async function runCycle(cycleNum: number): Promise<CycleStats> {
  const stats: CycleStats = {
    cycle: cycleNum,
    queriesRun: 0,
    stored: 0,
    duplicates: 0,
    errors: 0,
    grokCalls: 0,
    grokRateLimited: 0,
    startTime: Date.now(),
  }

  log(`═══ Cycle ${cycleNum} starting ═══`)

  // Pick queries for this cycle
  const queries = pickQueries(QUERIES_PER_CYCLE)
  log(`Running ${queries.length} queries`)

  // Execute each query
  for (const query of queries) {
    stats.queriesRun++
    
    // Check for cached alternative
    const cachedAlt = getCachedAlternative(query)
    const effectiveQuery = cachedAlt || query

    if (cachedAlt) {
      log(`  Using cached alternative: "${effectiveQuery.substring(0, 50)}..."`)
    }

    const result = await runPipeline(effectiveQuery)
    stats.stored += result.stored
    stats.duplicates += result.duplicates

    if (result.error) {
      stats.errors++
      log(`  Query failed: ${result.error}`, 'error')
    } else {
      log(`  ${query.substring(0, 40)}... → stored=${result.stored}, dupes=${result.duplicates}`)
    }

    // Queue for Grok if too many duplicates and no cached alternative
    if (result.duplicates >= 2 && !cachedAlt && GROK_ENABLED) {
      queueDuplicateQuery(query)
    }

    // Small delay between queries
    await new Promise(r => setTimeout(r, 2000))
  }

  // Process Grok queue at end of cycle
  if (GROK_ENABLED) {
    const grokResult = await processGrokQueue()
    stats.grokCalls = grokResult.processed > 0 ? 1 : 0
    stats.grokRateLimited = grokResult.rateLimited ? 1 : 0
  }

  stats.endTime = Date.now()
  const durationSec = Math.round((stats.endTime - stats.startTime) / 1000)

  log(`═══ Cycle ${cycleNum} complete ═══`)
  log(`  Duration: ${durationSec}s`)
  log(`  Queries: ${stats.queriesRun}, Stored: ${stats.stored}, Dupes: ${stats.duplicates}`)
  log(`  Grok: calls=${stats.grokCalls}, rateLimited=${stats.grokRateLimited}`)

  if (isCaptureEnabled()) {
    log(`  Training capture: ${JSON.stringify(getCaptureStats())}`)
  }

  return stats
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  log('════════════════════════════════════════════════════════════')
  log(`Market Monitor Starting (TypeScript)`)
  log(`  Instance: ${INSTANCE}`)
  log(`  Cycles: ${MAX_CYCLES || 'infinite'}`)
  log(`  Delay: ${CYCLE_DELAY_SEC}s between cycles`)
  log(`  Queries/cycle: ${QUERIES_PER_CYCLE}`)
  log(`  Grok enabled: ${GROK_ENABLED}`)
  log(`  Training capture: ${isCaptureEnabled()}`)
  log('════════════════════════════════════════════════════════════')

  let cycle = 1
  
  while (MAX_CYCLES === 0 || cycle <= MAX_CYCLES) {
    await runCycle(cycle)

    if (MAX_CYCLES > 0 && cycle >= MAX_CYCLES) {
      break
    }

    log(`Sleeping ${CYCLE_DELAY_SEC}s until next cycle...`)
    await new Promise(r => setTimeout(r, CYCLE_DELAY_SEC * 1000))
    cycle++
  }

  log('Market Monitor finished.')
}

main().catch((err) => {
  log(`Fatal error: ${err.message}`, 'error')
  process.exit(1)
})
