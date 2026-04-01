import { randomUUID } from 'crypto'
import { queryModelWithStreaming } from '../services/api/claude.js'
import { queryModelWithRouting } from '../services/llm/queryModelRouter.js'
import { autoCompactIfNeeded } from '../services/compact/autoCompact.js'
import { microcompactMessages } from '../services/compact/microCompact.js'

// -- deps

// I/O dependencies for query(). Passing a `deps` override into QueryParams
// lets tests inject fakes directly instead of spyOn-per-module — the most
// common mocks (callModel, autocompact) are each spied in 6-8 test files
// today with module-import-and-spy boilerplate.
//
// Using `typeof fn` keeps signatures in sync with the real implementations
// automatically. This file imports the real functions for both typing and
// the production factory — tests that import this file for typing are
// already importing query.ts (which imports everything), so there's no
// new module-graph cost.
//
// Scope is intentionally narrow (4 deps) to prove the pattern. Followup
// PRs can add runTools, handleStopHooks, logEvent, queue ops, etc.
export type QueryDeps = {
  // -- model
  callModel: typeof queryModelWithStreaming

  // -- compaction
  microcompact: typeof microcompactMessages
  autocompact: typeof autoCompactIfNeeded

  // -- platform
  uuid: () => string
}

/**
 * Check if local-first routing is enabled via environment
 */
function isLocalFirstEnabled(): boolean {
  return !!process.env.OLLAMA_BASE_URL || process.env.LOCAL_FIRST === 'true'
}

export function productionDeps(): QueryDeps {
  // Use local-first routing when OLLAMA_BASE_URL or LOCAL_FIRST is set
  const callModel = isLocalFirstEnabled()
    ? (queryModelWithRouting as typeof queryModelWithStreaming)
    : queryModelWithStreaming

  return {
    callModel,
    microcompact: microcompactMessages,
    autocompact: autoCompactIfNeeded,
    uuid: randomUUID,
  }
}

/**
 * Force Claude-only deps (bypass local routing)
 */
export function claudeOnlyDeps(): QueryDeps {
  return {
    callModel: queryModelWithStreaming,
    microcompact: microcompactMessages,
    autocompact: autoCompactIfNeeded,
    uuid: randomUUID,
  }
}

/**
 * Force local-first deps (always try Ollama first)
 */
export function localFirstDeps(): QueryDeps {
  return {
    callModel: queryModelWithRouting as typeof queryModelWithStreaming,
    microcompact: microcompactMessages,
    autocompact: autoCompactIfNeeded,
    uuid: randomUUID,
  }
}

