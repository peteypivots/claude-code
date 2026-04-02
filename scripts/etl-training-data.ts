#!/usr/bin/env bun
/**
 * etl-training-data.ts — ETL pipeline: JSONL sessions → LanceDB training tables
 *
 * Reads session JSONL files, extracts turns via parentUuid chains,
 * generates embeddings, deduplicates, computes quality scores,
 * and inserts into LanceDB training tables.
 *
 * Usage:
 *   bun run scripts/etl-training-data.ts [--session-dir <path>] [--verbose] [--dry-run]
 *
 * Environment:
 *   LANCEDB_URI       — LanceDB REST API (default: http://lancedb-api:8000)
 *   OLLAMA_BASE_URL   — Ollama API for embeddings (default: http://ollama:11434)
 *   EMBEDDING_MODEL   — Embedding model (default: nomic-embed-text)
 */

import { createHash, randomUUID } from 'crypto'
import { readFileSync, readdirSync, existsSync, writeFileSync, statSync, mkdirSync } from 'fs'
import { join, basename, dirname } from 'path'
import { homedir } from 'os'

// ── Config ────────────────────────────────────────────────
const LANCEDB_URI = process.env.LANCEDB_URI || 'http://lancedb-api:8000'
const OLLAMA_BASE_URL = process.env.OLLAMA_BASE_URL || 'http://ollama:11434'
const EMBEDDING_MODEL = process.env.EMBEDDING_MODEL || 'nomic-embed-text'
const DB = 'user_dbs'
const DEDUP_SIMILARITY_THRESHOLD = 0.9
const PROGRESS_FILE = join(homedir(), '.claude-code', '.etl-progress.json')

const args = process.argv.slice(2)
const verbose = args.includes('--verbose')
const dryRun = args.includes('--dry-run')
const sessionDirArg = args.find((_, i) => args[i - 1] === '--session-dir')
const sessionDir = sessionDirArg || join(homedir(), '.claude-code', 'projects')

// ── Types ─────────────────────────────────────────────────
interface RawMessage {
  type: string
  uuid: string
  parentUuid?: string | null
  timestamp?: string
  sessionId?: string
  message?: {
    role?: string
    content?: string | Array<{
      type: string
      text?: string
      name?: string
      id?: string
      input?: unknown
      content?: string | unknown
      is_error?: boolean
      tool_use_id?: string
    }>
    model?: string
  }
  // Training metadata (Phase 1 fields)
  modelUsed?: string
  routingDecision?: string
  routingConfidence?: number
  latencyMs?: number
  toolOutcome?: string
  feedback?: string | null
}

interface Turn {
  system?: string
  user: string
  assistant: string
  toolCalls: ToolCall[]
  metadata: {
    sessionId: string
    turnIndex: number
    modelUsed?: string
    routingDecision?: string
    routingConfidence?: number
    latencyMs?: number
    feedback?: string | null
    timestamp: string
  }
}

interface ToolCall {
  name: string
  input: string
  output: string
  outcome: string
  timestamp: string
}

interface ETLProgress {
  [filePath: string]: { lastLine: number; lastModified: number }
}

// ── Helpers ───────────────────────────────────────────────
function log(msg: string) {
  if (verbose) console.log(`[ETL] ${msg}`)
}

function canonicalize(text: string): string {
  const stopwords = new Set(['the', 'a', 'an', 'is', 'are', 'was', 'were', 'be', 'been',
    'being', 'have', 'has', 'had', 'do', 'does', 'did', 'will', 'would', 'could', 'should',
    'may', 'might', 'shall', 'can', 'to', 'of', 'in', 'for', 'on', 'with', 'at', 'by',
    'from', 'as', 'into', 'through', 'during', 'before', 'after', 'above', 'below',
    'between', 'this', 'that', 'these', 'those', 'i', 'me', 'my', 'we', 'our', 'you', 'your',
    'he', 'him', 'his', 'she', 'her', 'it', 'its', 'they', 'them', 'their'])
  return text
    .toLowerCase()
    .replace(/[^\w\s]/g, ' ')
    .split(/\s+/)
    .filter(w => w.length > 1 && !stopwords.has(w))
    .sort()
    .join(' ')
}

function contentHash(text: string): string {
  return createHash('sha256').update(text.toLowerCase()).digest('hex')
}

function extractText(content: unknown): string {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content
      .filter((c: any) => c.type === 'text' && c.text)
      .map((c: any) => c.text)
      .join('\n')
  }
  return ''
}

function extractToolCalls(content: unknown): Array<{ name: string; id: string; input: unknown }> {
  if (!Array.isArray(content)) return []
  return content
    .filter((c: any) => c.type === 'tool_use')
    .map((c: any) => ({ name: c.name || '', id: c.id || '', input: c.input || {} }))
}

function extractToolResults(content: unknown): Array<{ toolUseId: string; content: string; isError: boolean }> {
  if (!Array.isArray(content)) return []
  return content
    .filter((c: any) => c.type === 'tool_result')
    .map((c: any) => ({
      toolUseId: c.tool_use_id || '',
      content: typeof c.content === 'string' ? c.content : JSON.stringify(c.content || ''),
      isError: !!c.is_error,
    }))
}

// ── Embedding ─────────────────────────────────────────────
const embeddingCache = new Map<string, number[]>()

async function getEmbedding(text: string): Promise<number[]> {
  const truncated = text.substring(0, 2000) // nomic-embed-text max ~2048 tokens
  const cacheKey = contentHash(truncated)
  if (embeddingCache.has(cacheKey)) return embeddingCache.get(cacheKey)!

  try {
    const res = await fetch(`${OLLAMA_BASE_URL}/api/embed`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: EMBEDDING_MODEL, input: truncated }),
    })
    const data = await res.json() as { embeddings?: number[][] }
    const embedding = data.embeddings?.[0] || new Array(768).fill(0)
    embeddingCache.set(cacheKey, embedding)
    return embedding
  } catch (e) {
    log(`Embedding failed: ${e}`)
    return new Array(768).fill(0)
  }
}

// ── LanceDB REST helpers ──────────────────────────────────
const BATCH_SIZE = 20
const RATE_LIMIT_DELAY = 2500 // ms between API calls to stay under 30/min

async function sleep(ms: number) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

async function batchIngest(table: string, records: Record<string, unknown>[]): Promise<number> {
  if (records.length === 0) return 0
  if (dryRun) {
    log(`[DRY RUN] Would insert ${records.length} records into ${table}`)
    return records.length
  }
  let inserted = 0
  for (let i = 0; i < records.length; i += BATCH_SIZE) {
    const batch = records.slice(i, i + BATCH_SIZE)
    try {
      await sleep(RATE_LIMIT_DELAY)
      const res = await fetch(`${LANCEDB_URI}/dbs/${DB}/tables/${table}/ingest`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ records: batch }),
      })
      if (res.ok) {
        inserted += batch.length
      } else {
        const body = await res.text()
        log(`Batch ingest failed for ${table} (${res.status}): ${body.substring(0, 200)}`)
        // If rate limited, wait and retry once
        if (res.status === 429) {
          log('  Rate limited, waiting 60s...')
          await sleep(60000)
          const retry = await fetch(`${LANCEDB_URI}/dbs/${DB}/tables/${table}/ingest`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ records: batch }),
          })
          if (retry.ok) inserted += batch.length
        }
      }
    } catch (e) {
      log(`Batch ingest error for ${table}: ${e}`)
    }
  }
  return inserted
}

// Skip per-record hash check — use in-memory dedup instead
// LanceDB rate limits make per-record queries impractical

// ── Quality Score ─────────────────────────────────────────
function computeQualityScore(turn: Turn): number {
  const routingConf = turn.metadata.routingConfidence ?? 0.5
  const toolSuccess = turn.toolCalls.length > 0
    ? turn.toolCalls.filter(t => t.outcome === 'success').length / turn.toolCalls.length
    : 1.0 // no tools = neutral
  const feedbackScore = turn.metadata.feedback === 'up' ? 1.0
    : turn.metadata.feedback === 'down' ? 0.0
    : 0.5

  return 0.4 * routingConf + 0.3 * toolSuccess + 0.3 * feedbackScore
}

// ── Auto-tag ──────────────────────────────────────────────
function autoTag(turn: Turn): string[] {
  const tags: string[] = []
  if (turn.toolCalls.length > 0) tags.push('tool_use')
  if (turn.toolCalls.length > 3) tags.push('multi_tool')
  if (turn.metadata.routingDecision === 'reason') tags.push('reasoning')
  if (turn.metadata.routingDecision === 'escalate') tags.push('escalated')
  if (turn.assistant.length > 2000) tags.push('long_response')
  if (turn.user.length > 1000) tags.push('long_prompt')
  if (turn.metadata.feedback) tags.push(`feedback_${turn.metadata.feedback}`)
  return tags
}

// ── "Used in final answer" heuristic ──────────────────────
function wasToolUsedInAnswer(toolOutput: string, finalAnswer: string): boolean {
  if (!toolOutput || !finalAnswer) return false
  // Extract key phrases (3+ word sequences) from tool output
  const phrases = toolOutput
    .substring(0, 1000)
    .split(/[.!?\n]/)
    .map(s => s.trim())
    .filter(s => s.split(/\s+/).length >= 3)
    .slice(0, 5)
  // Check if any key phrase appears in the final answer
  return phrases.some(phrase => {
    const normalized = phrase.toLowerCase().substring(0, 100)
    return finalAnswer.toLowerCase().includes(normalized)
  })
}

// ── Turn Grouping (via parentUuid chains) ─────────────────
function groupIntoTurns(messages: RawMessage[]): Turn[] {
  const turns: Turn[] = []
  let systemPrompt = ''
  let currentUserText = ''
  let currentToolCalls: ToolCall[] = []
  let currentAssistantText = ''
  let currentMeta: Turn['metadata'] | null = null
  let turnIndex = 0
  // Pending tool_use blocks waiting for results
  const pendingToolUses = new Map<string, { name: string; input: string; timestamp: string }>()

  function flushTurn() {
    if (currentUserText && currentAssistantText) {
      turns.push({
        system: systemPrompt || undefined,
        user: currentUserText,
        assistant: currentAssistantText,
        toolCalls: currentToolCalls,
        metadata: currentMeta!,
      })
    }
    currentUserText = ''
    currentAssistantText = ''
    currentToolCalls = []
    currentMeta = null
    pendingToolUses.clear()
    turnIndex++
  }

  for (const msg of messages) {
    if (msg.type === 'system') {
      systemPrompt = extractText(msg.message?.content)
      continue
    }

    if (msg.type === 'user') {
      const content = msg.message?.content
      // Check if this is a tool_result message
      const toolResults = extractToolResults(content)
      if (toolResults.length > 0) {
        // This is a tool result, match it to pending tool_uses
        for (const result of toolResults) {
          const pending = pendingToolUses.get(result.toolUseId)
          if (pending) {
            currentToolCalls.push({
              name: pending.name,
              input: pending.input,
              output: result.content.substring(0, 5000), // truncate large outputs
              outcome: result.isError ? 'error' : (msg.toolOutcome || 'success'),
              timestamp: msg.timestamp || '',
            })
            pendingToolUses.delete(result.toolUseId)
          }
        }
        continue
      }

      // Regular user message — flush previous turn
      if (currentUserText) {
        flushTurn()
      }
      currentUserText = extractText(content)
      currentMeta = {
        sessionId: msg.sessionId || '',
        turnIndex,
        timestamp: msg.timestamp || new Date().toISOString(),
      }
      continue
    }

    if (msg.type === 'assistant') {
      const content = msg.message?.content
      const text = extractText(content)
      const toolUses = extractToolCalls(content)

      // Track tool_use blocks for matching with results
      for (const tu of toolUses) {
        pendingToolUses.set(tu.id, {
          name: tu.name,
          input: JSON.stringify(tu.input).substring(0, 2000),
          timestamp: msg.timestamp || '',
        })
      }

      // The *final* assistant text in a turn (after all tool calls) is the answer
      if (text) {
        currentAssistantText = text
      }

      // Capture training metadata from the assistant message
      if (currentMeta) {
        if (msg.modelUsed) currentMeta.modelUsed = msg.modelUsed
        if (msg.routingDecision) currentMeta.routingDecision = msg.routingDecision
        if (msg.routingConfidence != null) currentMeta.routingConfidence = msg.routingConfidence
        if (msg.latencyMs != null) currentMeta.latencyMs = msg.latencyMs
        if (msg.feedback !== undefined) currentMeta.feedback = msg.feedback
      }
      continue
    }
  }

  // Flush last turn
  flushTurn()

  return turns
}

// ── Parse JSONL file ──────────────────────────────────────
function parseJSONL(filePath: string, startLine = 0): RawMessage[] {
  const content = readFileSync(filePath, 'utf-8')
  const lines = content.split('\n').filter(l => l.trim())
  const messages: RawMessage[] = []

  for (let i = startLine; i < lines.length; i++) {
    try {
      const entry = JSON.parse(lines[i])
      // Only process transcript messages (user, assistant, system)
      if (['user', 'assistant', 'system'].includes(entry.type)) {
        messages.push(entry)
      }
    } catch {
      // Skip malformed lines
    }
  }

  return messages
}

// ── Find session files ────────────────────────────────────
function findSessionFiles(baseDir: string): string[] {
  const files: string[] = []

  function walk(dir: string) {
    try {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = join(dir, entry.name)
        if (entry.isDirectory()) {
          walk(full)
        } else if (entry.name.endsWith('.jsonl')) {
          files.push(full)
        }
      }
    } catch {
      // Permission denied or not exists
    }
  }

  walk(baseDir)
  return files
}

// ── Load/Save progress ───────────────────────────────────
function loadProgress(): ETLProgress {
  try {
    return JSON.parse(readFileSync(PROGRESS_FILE, 'utf-8'))
  } catch {
    return {}
  }
}

function saveProgress(progress: ETLProgress) {
  const dir = dirname(PROGRESS_FILE)
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  writeFileSync(PROGRESS_FILE, JSON.stringify(progress, null, 2))
}

// ── Main ETL Pipeline ─────────────────────────────────────
async function main() {
  console.log('=== Training Data ETL Pipeline ===')
  console.log(`  Session dir: ${sessionDir}`)
  console.log(`  LanceDB:     ${LANCEDB_URI}`)
  console.log(`  Embeddings:  ${OLLAMA_BASE_URL} (${EMBEDDING_MODEL})`)
  console.log(`  Dry run:     ${dryRun}`)
  console.log('')

  const progress = loadProgress()
  const sessionFiles = findSessionFiles(sessionDir)
  console.log(`Found ${sessionFiles.length} session files`)

  let totalTurns = 0
  let totalInserted = 0
  let totalSkipped = 0
  let totalTools = 0
  let totalRouting = 0

  // Accumulate records for batch insert
  const trainingBatch: Record<string, unknown>[] = []
  const toolBatch: Record<string, unknown>[] = []
  const routingBatch: Record<string, unknown>[] = []
  const seenHashes = new Set<string>()

  for (const filePath of sessionFiles) {
    const stat = statSync(filePath)
    const lastMod = stat.mtimeMs
    const prevProgress = progress[filePath]

    // Skip if file hasn't changed since last ETL
    if (prevProgress && prevProgress.lastModified >= lastMod) {
      log(`Skipping unchanged: ${basename(filePath)}`)
      continue
    }

    const startLine = prevProgress?.lastLine || 0
    log(`Processing: ${basename(filePath)} (from line ${startLine})`)

    const messages = parseJSONL(filePath, startLine)
    if (messages.length === 0) {
      progress[filePath] = { lastLine: startLine, lastModified: lastMod }
      continue
    }

    const turns = groupIntoTurns(messages)
    log(`  ${turns.length} turns extracted`)

    for (const turn of turns) {
      totalTurns++

      // ── Content hash dedup (in-memory) ──────────────
      const hash = contentHash(turn.user + turn.assistant)
      if (seenHashes.has(hash)) {
        totalSkipped++
        log(`  Skipped (hash dedup): turn ${turn.metadata.turnIndex}`)
        continue
      }
      seenHashes.add(hash)

      // ── Embed user+assistant (selective — skip tool logs) ──
      const embeddingText = `${turn.user}\n\n${turn.assistant}`.substring(0, 2000)
      const embedding = await getEmbedding(embeddingText)

      // ── Quality score ───────────────────────────────
      const qualityScore = computeQualityScore(turn)

      // ── Canonical prompt dedup ──────────────────────
      const canonical = canonicalize(turn.user)

      // ── Auto-tag ────────────────────────────────────
      const tags = autoTag(turn)

      // ── Check "used in final answer" for tools ──────
      for (const tc of turn.toolCalls) {
        const used = wasToolUsedInAnswer(tc.output, turn.assistant)
        if (tc.outcome === 'success' && !used) {
          tc.outcome = 'partial' // tool worked but output not used
        }
      }

      // ── Accumulate training_examples ────────────────
      const turnId = randomUUID()
      trainingBatch.push({
        id: turnId,
        session_id: turn.metadata.sessionId,
        system_prompt: (turn.system || '').substring(0, 5000),
        user_content: turn.user.substring(0, 10000),
        assistant_content: turn.assistant.substring(0, 10000),
        canonical_prompt: canonical.substring(0, 1000),
        model_used: turn.metadata.modelUsed || 'unknown',
        routing_decision: turn.metadata.routingDecision || 'unknown',
        routing_confidence: turn.metadata.routingConfidence ?? 0.5,
        latency_ms: turn.metadata.latencyMs ?? 0,
        feedback: turn.metadata.feedback || 'null',
        quality_score: qualityScore,
        tags: tags.join(','),
        content_hash: hash,
        turn_index: turn.metadata.turnIndex,
        timestamp: turn.metadata.timestamp,
        embedding,
      })

      // ── Accumulate tool_interactions ────────────────
      for (const tc of turn.toolCalls) {
        const toolEmbedding = await getEmbedding(tc.input.substring(0, 500))
        toolBatch.push({
          id: randomUUID(),
          session_id: turn.metadata.sessionId,
          turn_id: turnId,
          tool_name: tc.name,
          tool_input: tc.input.substring(0, 5000),
          tool_output: tc.output.substring(0, 5000),
          tool_outcome: tc.outcome,
          latency_ms: 0,
          used_in_final_answer: tc.outcome === 'success',
          timestamp: tc.timestamp || turn.metadata.timestamp,
          embedding: toolEmbedding,
        })
      }

      // ── Accumulate routing_decisions ────────────────
      if (turn.metadata.routingDecision && turn.metadata.routingDecision !== 'unknown') {
        const routingEmbedding = await getEmbedding(turn.user.substring(0, 500))
        routingBatch.push({
          id: randomUUID(),
          session_id: turn.metadata.sessionId,
          input_summary: turn.user.substring(0, 500),
          tool_count: turn.toolCalls.length,
          conversation_depth: turn.metadata.turnIndex,
          decision: turn.metadata.routingDecision,
          confidence: turn.metadata.routingConfidence ?? 0.5,
          model_used: turn.metadata.modelUsed || 'unknown',
          latency_ms: turn.metadata.latencyMs ?? 0,
          outcome: qualityScore > 0.6 ? 'success' : 'failure',
          timestamp: turn.metadata.timestamp,
          embedding: routingEmbedding,
        })
      }
    }

    // Update progress (total lines in file, not just processed)
    const totalLines = readFileSync(filePath, 'utf-8').split('\n').filter(l => l.trim()).length
    progress[filePath] = { lastLine: totalLines, lastModified: lastMod }
  }

  // ── Batch insert all accumulated records ────────────────
  console.log(`\nBatch inserting: ${trainingBatch.length} examples, ${toolBatch.length} tools, ${routingBatch.length} routing`)
  totalInserted = await batchIngest('training_examples', trainingBatch)
  totalTools = await batchIngest('tool_interactions', toolBatch)
  totalRouting = await batchIngest('routing_decisions', routingBatch)

  saveProgress(progress)

  console.log('')
  console.log('=== ETL Complete ===')
  console.log(`  Turns processed:    ${totalTurns}`)
  console.log(`  Examples inserted:  ${totalInserted}`)
  console.log(`  Duplicates skipped: ${totalSkipped}`)
  console.log(`  Tool records:       ${totalTools}`)
  console.log(`  Routing records:    ${totalRouting}`)
}

main().catch(e => {
  console.error('ETL failed:', e)
  process.exit(1)
})
