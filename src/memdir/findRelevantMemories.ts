import { feature } from 'bun:bundle'
import { appendFileSync } from 'fs'
import { logForDebugging } from '../utils/debug.js'
import { errorMessage } from '../utils/errors.js'
import { getDefaultSonnetModel } from '../utils/model/model.js'
import { sideQuery } from '../utils/sideQuery.js'
import { sideQuery as sideQueryLocal } from '../services/llm/sideQueryProvider.js'
import { jsonParse } from '../utils/slowOperations.js'
import {
  formatMemoryManifest,
  type MemoryHeader,
  scanMemoryFiles,
} from './memoryScan.js'
import { selectMemoriesVector } from './vectorMemorySelector.js'
import { captureMemorySelection, isDecisionCaptureEnabled } from '../services/llm/decisionCapture.js'

// Router debug log for agent-level visibility
const ROUTER_DEBUG_LOG = process.env.ROUTER_DEBUG_LOG ?? '/data/logs/router-debug.log'
function routerLog(msg: string) {
  const ts = new Date().toISOString()
  try {
    appendFileSync(ROUTER_DEBUG_LOG, `${ts} [Memory] ${msg}\n`)
  } catch { /* ignore */ }
}

/** Check if we're in local-first mode (Ollama) */
function isLocalFirst(): boolean {
  return !!(process.env.OLLAMA_BASE_URL || process.env.LOCAL_FIRST === 'true')
}

/** Check if vector memory selector should be used (default: true when local-first) */
function useVectorMemory(): boolean {
  if (process.env.USE_VECTOR_MEMORY === 'false') return false
  if (process.env.USE_VECTOR_MEMORY === 'true') return true
  // Default: enable when local-first mode is active
  return isLocalFirst()
}

/**
 * Extract JSON from LLM text that may be wrapped in markdown fences or preamble.
 * Local models often return ```json\n{...}\n``` instead of raw JSON.
 */
function extractJson(text: string): string {
  // Try raw first
  const trimmed = text.trim()
  if (trimmed.startsWith('{')) return trimmed

  // Strip markdown fences: ```json ... ``` or ``` ... ```
  const fenceMatch = trimmed.match(/```(?:json)?\s*\n?([\s\S]*?)\n?```/)
  if (fenceMatch) return fenceMatch[1].trim()

  // Last resort: find first { to last }
  const first = trimmed.indexOf('{')
  const last = trimmed.lastIndexOf('}')
  if (first !== -1 && last > first) return trimmed.slice(first, last + 1)

  return trimmed
}

export type RelevantMemory = {
  path: string
  mtimeMs: number
}

const SELECT_MEMORIES_SYSTEM_PROMPT = `You are selecting memories that will be useful to Claude Code as it processes a user's query. You will be given the user's query and a list of available memory files with their filenames and descriptions.

Return a list of filenames for the memories that will clearly be useful to Claude Code as it processes the user's query (up to 5). Only include memories that you are certain will be helpful based on their name and description.
- If you are unsure if a memory will be useful in processing the user's query, then do not include it in your list. Be selective and discerning.
- If there are no memories in the list that would clearly be useful, feel free to return an empty list.
- If a list of recently-used tools is provided, do not select memories that are usage reference or API documentation for those tools (Claude Code is already exercising them). DO still select memories containing warnings, gotchas, or known issues about those tools — active use is exactly when those matter.
`

/**
 * Find memory files relevant to a query by scanning memory file headers
 * and asking Sonnet to select the most relevant ones.
 *
 * Returns absolute file paths + mtime of the most relevant memories
 * (up to 5). Excludes MEMORY.md (already loaded in system prompt).
 * mtime is threaded through so callers can surface freshness to the
 * main model without a second stat.
 *
 * `alreadySurfaced` filters paths shown in prior turns before the
 * Sonnet call, so the selector spends its 5-slot budget on fresh
 * candidates instead of re-picking files the caller will discard.
 */
export async function findRelevantMemories(
  query: string,
  memoryDir: string,
  signal: AbortSignal,
  recentTools: readonly string[] = [],
  alreadySurfaced: ReadonlySet<string> = new Set(),
): Promise<RelevantMemory[]> {
  routerLog(`ENTER findRelevantMemories: dir=${memoryDir}, query="${query.slice(0, 50)}..."`)
  const memories = (await scanMemoryFiles(memoryDir, signal)).filter(
    m => !alreadySurfaced.has(m.filePath),
  )
  if (memories.length === 0) {
    return []
  }

  const selectedFilenames = await selectRelevantMemories(
    query,
    memories,
    memoryDir,
    signal,
    recentTools,
  )
  const byFilename = new Map(memories.map(m => [m.filename, m]))
  const selected = selectedFilenames
    .map(filename => byFilename.get(filename))
    .filter((m): m is MemoryHeader => m !== undefined)

  // Fires even on empty selection: selection-rate needs the denominator,
  // and -1 ages distinguish "ran, picked nothing" from "never ran".
  if (feature('MEMORY_SHAPE_TELEMETRY')) {
    /* eslint-disable @typescript-eslint/no-require-imports */
    const { logMemoryRecallShape } =
      require('./memoryShapeTelemetry.js') as typeof import('./memoryShapeTelemetry.js')
    /* eslint-enable @typescript-eslint/no-require-imports */
    logMemoryRecallShape(memories, selected)
  }

  return selected.map(m => ({ path: m.filePath, mtimeMs: m.mtimeMs }))
}

async function selectRelevantMemories(
  query: string,
  memories: MemoryHeader[],
  memoryDir: string,
  signal: AbortSignal,
  recentTools: readonly string[],
): Promise<string[]> {
  const validFilenames = new Set(memories.map(m => m.filename))

  // ── Vector selector (fast path: ~60ms, 0 tokens) ──────────────────────────
  if (useVectorMemory()) {
    try {
      const vectorResult = await selectMemoriesVector(query, memoryDir)
      if (vectorResult.selector === 'vector' && vectorResult.memories.length > 0) {
        const vectorFilenames = vectorResult.memories
          .map(m => m.filename)
          .filter(f => validFilenames.has(f))
        logForDebugging(
          `[memdir] Vector memory recall selected ${vectorFilenames.length} memories in ${vectorResult.latencyMs}ms (index: ${vectorResult.indexStatus})`,
        )
        routerLog(`VECTOR selected ${vectorFilenames.length} memories in ${vectorResult.latencyMs}ms: ${vectorFilenames.slice(0, 3).join(', ')}${vectorFilenames.length > 3 ? '...' : ''}`)
        return vectorFilenames
      }
      // Vector returned empty or fell back — continue to LLM
      logForDebugging(
        `[memdir] Vector selector returned ${vectorResult.selector}, falling back to LLM`,
      )
      routerLog(`VECTOR fallback: selector=${vectorResult.selector}, memories=${vectorResult.memories.length}`)
    } catch (e) {
      logForDebugging(
        `[memdir] Vector selector failed: ${errorMessage(e)}, falling back to LLM`,
        { level: 'warn' },
      )
      routerLog(`VECTOR error: ${errorMessage(e)}, falling back to LLM`)
    }
  }

  // ── LLM selector (slow path: ~2000ms, ~500 tokens) ────────────────────────
  const llmStartTime = Date.now()
  const manifest = formatMemoryManifest(memories)

  // When Claude Code is actively using a tool (e.g. mcp__X__spawn),
  // surfacing that tool's reference docs is noise — the conversation
  // already contains working usage.  The selector otherwise matches
  // on keyword overlap ("spawn" in query + "spawn" in a memory
  // description → false positive).
  const toolsSection =
    recentTools.length > 0
      ? `\n\nRecently used tools: ${recentTools.join(', ')}`
      : ''

  const userContent = `Query: ${query}\n\nAvailable memories:\n${manifest}${toolsSection}`

  try {
    // In local-first mode, use Ollama-aware sideQueryProvider
    if (isLocalFirst()) {
      const localResult = await sideQueryLocal({
        prompt: userContent,
        systemPrompt: SELECT_MEMORIES_SYSTEM_PROMPT,
        maxTokens: 256,
        temperature: 0,
      })

      // Parse JSON from the local provider's text response
      const parsed: { selected_memories: string[] } = jsonParse(extractJson(localResult.text))
      const selectedFilenames = parsed.selected_memories.filter(f => validFilenames.has(f))
      const llmLatency = Date.now() - llmStartTime
      logForDebugging(
        `[memdir] Local memory recall selected ${selectedFilenames.length} memories via ${localResult.provider}/${localResult.model} in ${llmLatency}ms`,
      )
      routerLog(`LLM selected ${selectedFilenames.length} memories in ${llmLatency}ms via ${localResult.provider}/${localResult.model}: ${selectedFilenames.slice(0, 3).join(', ')}${selectedFilenames.length > 3 ? '...' : ''}`)

      // Capture decision event for LLM fallback
      if (isDecisionCaptureEnabled()) {
        captureMemorySelection({
          query,
          selectedFiles: selectedFilenames,
          selector: 'llm',
          latencyMs: llmLatency,
          indexStatus: 'unavailable',
        }).catch(() => {})  // Fire and forget
      }

      return selectedFilenames
    }

    // Default: Anthropic sideQuery (original path)
    const result = await sideQuery({
      model: getDefaultSonnetModel(),
      system: SELECT_MEMORIES_SYSTEM_PROMPT,
      skipSystemPromptPrefix: true,
      messages: [
        {
          role: 'user',
          content: `Query: ${query}\n\nAvailable memories:\n${manifest}${toolsSection}`,
        },
      ],
      max_tokens: 256,
      output_format: {
        type: 'json_schema',
        schema: {
          type: 'object',
          properties: {
            selected_memories: { type: 'array', items: { type: 'string' } },
          },
          required: ['selected_memories'],
          additionalProperties: false,
        },
      },
      signal,
      querySource: 'memdir_relevance',
    })

    const textBlock = result.content.find(block => block.type === 'text')
    if (!textBlock || textBlock.type !== 'text') {
      return []
    }

    const parsed: { selected_memories: string[] } = jsonParse(textBlock.text)
    const selectedFilenames = parsed.selected_memories.filter(f => validFilenames.has(f))
    const llmLatency = Date.now() - llmStartTime

    // Capture decision event for Anthropic path
    if (isDecisionCaptureEnabled()) {
      captureMemorySelection({
        query,
        selectedFiles: selectedFilenames,
        selector: 'llm',
        latencyMs: llmLatency,
        indexStatus: 'unavailable',
      }).catch(() => {})  // Fire and forget
    }

    return selectedFilenames
  } catch (e) {
    if (signal.aborted) {
      return []
    }
    logForDebugging(
      `[memdir] selectRelevantMemories failed: ${errorMessage(e)}`,
      { level: 'warn' },
    )
    return []
  }
}

