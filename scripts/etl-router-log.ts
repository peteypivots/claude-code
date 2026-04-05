#!/usr/bin/env bun
/**
 * ETL: Parse router-debug.log into training examples and ingest to LanceDB.
 *
 * Extracts conversation turns from the structured [Router] log lines:
 *   NEW QUERY → ROUTING → System prompt → user messages → MODEL RESPONSE → Tokens
 *
 * Usage (inside container):
 *   bun run /app/scripts/etl-router-log.ts /data/logs/router-debug.log
 */

const LANCEDB_URI = process.env.LANCEDB_URI || 'http://lancedb-api:8000'
const DB = 'user_dbs'
const TABLE = 'training_examples'
const OLLAMA_URL = process.env.OLLAMA_BASE_URL || 'http://ollama:11434'
const EMBED_MODEL = process.env.EMBED_MODEL || 'nomic-embed-text'

// ── Types ───────────────────────────────────────────────────────────────────

interface Turn {
  timestamp: string
  query: string
  routingDecision: string // local | escalate | reason
  routingReason: string
  suggestedTool: string
  systemPrompt: string
  model: string
  inputTokens: number
  outputTokens: number
  responseType: 'text' | 'tool_use'
  responseText: string // text content or tool name
  toolNames: string[] // tools used in response
  stopReason: string
  msgId: string
}

// ── Embedding ───────────────────────────────────────────────────────────────

async function getEmbedding(text: string): Promise<number[]> {
  const truncated = text.slice(0, 2000)
  const res = await fetch(`${OLLAMA_URL}/api/embed`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: EMBED_MODEL, input: truncated }),
  })
  if (!res.ok) throw new Error(`Embedding failed: ${res.status}`)
  const data = await res.json()
  return data.embeddings[0]
}

// ── Log Parser ──────────────────────────────────────────────────────────────

function parseTurns(lines: string[]): Turn[] {
  const turns: Turn[] = []
  let i = 0

  while (i < lines.length) {
    const line = lines[i]

    // Look for NEW QUERY markers
    const queryMatch = line.match(/^\[([^\]]+)\] \[Router\] NEW QUERY: "(.*)"$/)
    if (!queryMatch) {
      i++
      continue
    }

    const turn: Turn = {
      timestamp: queryMatch[1],
      query: queryMatch[2],
      routingDecision: '',
      routingReason: '',
      suggestedTool: '',
      systemPrompt: '',
      model: '',
      inputTokens: 0,
      outputTokens: 0,
      responseType: 'text',
      responseText: '',
      toolNames: [],
      stopReason: '',
      msgId: '',
    }

    // Scan forward up to ~800 lines for the rest of this turn
    const end = Math.min(i + 800, lines.length)
    let j = i + 1

    while (j < end) {
      const l = lines[j]

      // Routing decision
      const routeMatch = l.match(/ROUTING → (\w+)/)
      if (routeMatch) {
        turn.routingDecision = routeMatch[1].toLowerCase()
      }

      // Routing reason
      const reasonMatch = l.match(/Reason: (.+)/)
      if (reasonMatch) {
        turn.routingReason = reasonMatch[1]
      }

      // Suggested tool
      const toolHintMatch = l.match(/Suggested tool: (.+)/)
      if (toolHintMatch) {
        turn.suggestedTool = toolHintMatch[1]
      }

      // System prompt
      const sysMatch = l.match(/System prompt: (.+)/)
      if (sysMatch) {
        turn.systemPrompt = sysMatch[1].slice(0, 500)
      }

      // Model
      const modelMatch = l.match(/Calling local model: (.+)/)
      if (modelMatch) {
        turn.model = modelMatch[1]
      }

      // Tokens
      const tokenMatch = l.match(/Tokens: (\d+) in \/ (\d+) out/)
      if (tokenMatch) {
        turn.inputTokens = parseInt(tokenMatch[1], 10)
        turn.outputTokens = parseInt(tokenMatch[2], 10)
      }

      // TEXT block
      const textMatch = l.match(/TEXT block: "(.*)"/)
      if (textMatch) {
        turn.responseType = 'text'
        turn.responseText = textMatch[1]
      }

      // TOOL_USE block
      const toolMatch = l.match(/TOOL_USE block: (.+)/)
      if (toolMatch) {
        turn.responseType = 'tool_use'
        turn.toolNames.push(toolMatch[1])
      }

      // AssistantMessage created (end of turn)
      const msgMatch = l.match(/AssistantMessage created: id=([^,]+), stop_reason=(.+)/)
      if (msgMatch) {
        turn.msgId = msgMatch[1]
        turn.stopReason = msgMatch[2]
        break
      }

      // Another NEW QUERY means this turn was incomplete
      if (l.match(/\[Router\] NEW QUERY:/)) {
        break
      }

      j++
    }

    // Only keep turns that completed (have a msg ID)
    if (turn.msgId) {
      turns.push(turn)
    }

    i = j + 1
  }

  return turns
}

// ── Ingest ──────────────────────────────────────────────────────────────────

async function ingestBatch(records: Record<string, unknown>[]) {
  const res = await fetch(`${LANCEDB_URI}/dbs/${DB}/tables/${TABLE}/ingest`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ records }),
    signal: AbortSignal.timeout(60000),
  })
  if (!res.ok) {
    const body = await res.text()
    throw new Error(`Ingest failed ${res.status}: ${body.slice(0, 300)}`)
  }
  return await res.json()
}

// ── Main ────────────────────────────────────────────────────────────────────

async function main() {
  const logPath = process.argv[2] || '/data/logs/router-debug.log'
  console.log(`Reading ${logPath}...`)

  const content = await Bun.file(logPath).text()
  const lines = content.split('\n')
  console.log(`Lines: ${lines.length}`)

  const turns = parseTurns(lines)
  console.log(`Parsed ${turns.length} complete turns`)

  if (turns.length === 0) {
    console.log('No turns found. Exiting.')
    return
  }

  // Deduplicate by msgId — may already be in LanceDB
  const existingIds = new Set<string>()
  try {
    const res = await fetch(`${LANCEDB_URI}/dbs/${DB}/tables/${TABLE}/query`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ select: ['id'], limit: 10000 }),
    })
    if (res.ok) {
      const data = await res.json()
      for (const r of data.records || []) {
        existingIds.add(r.id)
      }
    }
  } catch {
    // table may not exist yet, that's fine
  }

  const newTurns = turns.filter(t => !existingIds.has(t.msgId))
  console.log(`New turns to ingest: ${newTurns.length} (${turns.length - newTurns.length} already exist)`)

  if (newTurns.length === 0) {
    console.log('All turns already ingested. Done.')
    return
  }

  // Build records with embeddings
  const BATCH_SIZE = 20
  let totalIngested = 0

  for (let i = 0; i < newTurns.length; i += BATCH_SIZE) {
    const batch = newTurns.slice(i, i + BATCH_SIZE)
    const records: Record<string, unknown>[] = []

    for (const turn of batch) {
      // Build a useful text for embedding
      const embedText = `${turn.query} ${turn.responseText || turn.toolNames.join(', ')}`

      let embedding: number[]
      try {
        embedding = await getEmbedding(embedText)
      } catch (e) {
        console.error(`Embedding error for ${turn.msgId}: ${e}`)
        continue
      }

      const assistantContent = turn.responseType === 'tool_use'
        ? `[tool_use: ${turn.toolNames.join(', ')}]`
        : turn.responseText

      records.push({
        id: turn.msgId,
        session_id: `etl-router-log-${turn.timestamp.split('T')[0]}`,
        system_prompt: turn.systemPrompt,
        user_content: turn.query,
        assistant_content: assistantContent,
        canonical_prompt: JSON.stringify([
          { role: 'user', content: turn.query },
          { role: 'assistant', content: assistantContent },
        ]),
        model_used: turn.model || 'claude-explorer:v7',
        routing_decision: turn.routingDecision,
        routing_confidence: 0.0,
        routing_reason: turn.routingReason,
        suggested_tool: turn.suggestedTool,
        input_tokens: turn.inputTokens,
        output_tokens: turn.outputTokens,
        latency_ms: 0,
        feedback: '',
        quality_score: 0.5,
        tags: `etl,log-import,${turn.responseType}`,
        content_hash: Bun.hash(embedText).toString(16),
        turn_index: i + batch.indexOf(turn),
        timestamp: new Date(turn.timestamp).toISOString(),
        embedding,
      })
    }

    if (records.length === 0) continue

    try {
      const result = await ingestBatch(records)
      totalIngested += result.ingested
      process.stdout.write(`[${i + records.length}/${newTurns.length}] `)
    } catch (e) {
      console.error(`\nBatch ${i} failed: ${e}`)
    }
  }

  console.log(`\nDone: ${totalIngested} turns ingested into ${TABLE}`)
}

main().catch(console.error)
