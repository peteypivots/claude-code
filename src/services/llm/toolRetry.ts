/**
 * toolRetry.ts — Tool Retry & Circuit Breaker for MCP Tools
 *
 * Provides:
 * - Retry logic with exponential backoff (1s, 3s)
 * - Circuit breaker pattern (trips after 3 consecutive failures)
 * - Structured error responses with fallback suggestions
 * - Tool fallback chain recommendations
 *
 * Usage:
 *   const wrapper = new ToolRetryWrapper()
 *   const result = await wrapper.executeWithRetry('meta_ai_chat', () => callTool(...))
 */

// ── Config ────────────────────────────────────────────────────────────────────

const MAX_RETRIES = 2
const INITIAL_BACKOFF_MS = 1000
const BACKOFF_MULTIPLIER = 3
const CIRCUIT_BREAKER_THRESHOLD = 3
const CIRCUIT_BREAKER_RESET_MS = 60000 // 1 minute

// ── Types ─────────────────────────────────────────────────────────────────────

export interface ToolRetryResult<T> {
  success: boolean
  result?: T
  error?: ToolRetryError
  attempts: number
  totalDurationMs: number
}

export interface ToolRetryError {
  failed: true
  tool: string
  reason: string
  statusCode?: number
  suggestion: string
  retriesAttempted: number
  circuitOpen: boolean
}

interface CircuitState {
  failures: number
  lastFailure: number
  isOpen: boolean
}

// ── Fallback Chain ────────────────────────────────────────────────────────────

/**
 * Tool fallback chain — when a tool fails, suggest an alternative
 */
const TOOL_FALLBACKS: Record<string, string[]> = {
  // MCP research tools → web search fallback
  'meta_ai_chat': ['WebSearch', 'WebFetch'],
  'nitter_search_tweets': ['WebSearch'],
  'nitter_user_tweets': ['WebSearch'],
  'nitter_advanced_search': ['WebSearch'],
  
  // Web tools → each other
  'WebSearch': ['WebFetch', 'meta_ai_chat'],
  'WebFetch': ['WebSearch'],
  
  // File tools → grep as fallback
  'Read': ['Grep', 'Glob'],
  
  // Default: no suggestion
}

/**
 * Get fallback suggestion for a failed tool
 */
export function getToolFallback(failedTool: string, failedTools: Set<string> = new Set()): string | null {
  const fallbacks = TOOL_FALLBACKS[failedTool] || []
  for (const fallback of fallbacks) {
    if (!failedTools.has(fallback)) {
      return fallback
    }
  }
  return null
}

// ── Error Classification ──────────────────────────────────────────────────────

/**
 * Classify error type for retry and circuit breaker decisions
 */
function classifyError(error: unknown): { retryable: boolean; reason: string; statusCode?: number } {
  if (error instanceof Error) {
    const msg = error.message.toLowerCase()
    
    // Network errors - retryable
    if (msg.includes('econnrefused') || msg.includes('econnreset') || msg.includes('etimedout')) {
      return { retryable: true, reason: 'Connection error', statusCode: 503 }
    }
    
    // Timeout - retryable
    if (msg.includes('timeout') || msg.includes('timed out')) {
      return { retryable: true, reason: 'Request timeout', statusCode: 504 }
    }
    
    // Rate limiting - retryable with longer backoff
    if (msg.includes('429') || msg.includes('rate limit') || msg.includes('too many requests')) {
      return { retryable: true, reason: 'Rate limited', statusCode: 429 }
    }
    
    // Server errors - retryable
    if (msg.includes('500') || msg.includes('502') || msg.includes('503') || msg.includes('504')) {
      const match = msg.match(/5\d\d/)
      return { retryable: true, reason: 'Server error', statusCode: match ? parseInt(match[0]) : 500 }
    }
    
    // Client errors - not retryable
    if (msg.includes('400') || msg.includes('401') || msg.includes('403') || msg.includes('404')) {
      const match = msg.match(/4\d\d/)
      return { retryable: false, reason: 'Client error', statusCode: match ? parseInt(match[0]) : 400 }
    }
    
    // Parse errors - not retryable
    if (msg.includes('json') || msg.includes('parse') || msg.includes('syntax')) {
      return { retryable: false, reason: 'Parse error' }
    }
  }
  
  // Unknown error - attempt retry once
  return { retryable: true, reason: 'Unknown error' }
}

// ── Sleep Helper ──────────────────────────────────────────────────────────────

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

// ── Main Class ────────────────────────────────────────────────────────────────

export class ToolRetryWrapper {
  private circuits: Map<string, CircuitState> = new Map()
  private failedTools: Set<string> = new Set()
  
  /**
   * Execute a tool call with retry logic and circuit breaker
   */
  async executeWithRetry<T>(
    toolName: string,
    executor: () => Promise<T>,
    options?: {
      maxRetries?: number
      skipCircuitBreaker?: boolean
    }
  ): Promise<ToolRetryResult<T>> {
    const maxRetries = options?.maxRetries ?? MAX_RETRIES
    const startTime = Date.now()
    let attempts = 0
    
    // Check circuit breaker
    const circuit = this.getCircuit(toolName)
    if (circuit.isOpen && !options?.skipCircuitBreaker) {
      // Check if enough time has passed to try again
      if (Date.now() - circuit.lastFailure < CIRCUIT_BREAKER_RESET_MS) {
        return {
          success: false,
          error: this.buildError(toolName, 'Circuit breaker open', undefined, true),
          attempts: 0,
          totalDurationMs: Date.now() - startTime,
        }
      }
      // Reset circuit for retry
      circuit.isOpen = false
      circuit.failures = 0
    }
    
    let lastError: unknown
    
    for (let retry = 0; retry <= maxRetries; retry++) {
      attempts++
      
      try {
        const result = await executor()
        // Success - reset circuit
        this.resetCircuit(toolName)
        this.failedTools.delete(toolName)
        return {
          success: true,
          result,
          attempts,
          totalDurationMs: Date.now() - startTime,
        }
      } catch (error) {
        lastError = error
        const classification = classifyError(error)
        
        // Update circuit breaker
        this.recordFailure(toolName)
        
        // Check if we should retry
        if (!classification.retryable || retry >= maxRetries) {
          break
        }
        
        // Exponential backoff
        const backoff = INITIAL_BACKOFF_MS * Math.pow(BACKOFF_MULTIPLIER, retry)
        // Extra delay for rate limiting
        const actualBackoff = classification.statusCode === 429 ? backoff * 2 : backoff
        await sleep(actualBackoff)
      }
    }
    
    // All retries failed
    this.failedTools.add(toolName)
    const classification = classifyError(lastError)
    
    return {
      success: false,
      error: this.buildError(
        toolName,
        classification.reason,
        classification.statusCode,
        this.getCircuit(toolName).isOpen
      ),
      attempts,
      totalDurationMs: Date.now() - startTime,
    }
  }
  
  /**
   * Build structured error with fallback suggestion
   */
  private buildError(
    toolName: string,
    reason: string,
    statusCode?: number,
    circuitOpen: boolean = false
  ): ToolRetryError {
    const fallback = getToolFallback(toolName, this.failedTools)
    const suggestion = fallback
      ? `Try using ${fallback} instead`
      : 'Answer using available context'
    
    return {
      failed: true,
      tool: toolName,
      reason,
      statusCode,
      suggestion,
      retriesAttempted: MAX_RETRIES,
      circuitOpen,
    }
  }
  
  /**
   * Get or create circuit state for a tool
   */
  private getCircuit(toolName: string): CircuitState {
    if (!this.circuits.has(toolName)) {
      this.circuits.set(toolName, { failures: 0, lastFailure: 0, isOpen: false })
    }
    return this.circuits.get(toolName)!
  }
  
  /**
   * Record a failure and potentially trip the circuit breaker
   */
  private recordFailure(toolName: string): void {
    const circuit = this.getCircuit(toolName)
    circuit.failures++
    circuit.lastFailure = Date.now()
    
    if (circuit.failures >= CIRCUIT_BREAKER_THRESHOLD) {
      circuit.isOpen = true
      console.log(`[ToolRetry] Circuit breaker OPEN for ${toolName} after ${circuit.failures} failures`)
    }
  }
  
  /**
   * Reset circuit state on success
   */
  private resetCircuit(toolName: string): void {
    const circuit = this.getCircuit(toolName)
    if (circuit.failures > 0 || circuit.isOpen) {
      circuit.failures = 0
      circuit.isOpen = false
      console.log(`[ToolRetry] Circuit breaker reset for ${toolName}`)
    }
  }
  
  /**
   * Get set of currently failed tools (for exclusion in fallback selection)
   */
  getFailedTools(): Set<string> {
    return new Set(this.failedTools)
  }
  
  /**
   * Clear all state (for testing or session reset)
   */
  reset(): void {
    this.circuits.clear()
    this.failedTools.clear()
  }
  
  /**
   * Get circuit breaker status for all tools
   */
  getStatus(): Record<string, { failures: number; isOpen: boolean }> {
    const status: Record<string, { failures: number; isOpen: boolean }> = {}
    for (const [tool, circuit] of this.circuits) {
      status[tool] = { failures: circuit.failures, isOpen: circuit.isOpen }
    }
    return status
  }
}

// ── Singleton Instance ────────────────────────────────────────────────────────

let instance: ToolRetryWrapper | null = null

export function getToolRetryWrapper(): ToolRetryWrapper {
  if (!instance) {
    instance = new ToolRetryWrapper()
  }
  return instance
}

/**
 * Execute a tool with retry (convenience function)
 */
export async function executeToolWithRetry<T>(
  toolName: string,
  executor: () => Promise<T>
): Promise<ToolRetryResult<T>> {
  return getToolRetryWrapper().executeWithRetry(toolName, executor)
}

/**
 * Format error for model consumption
 * Returns a structured message the model can understand and act on
 */
export function formatErrorForModel(error: ToolRetryError): string {
  const lines = [
    `Tool "${error.tool}" failed: ${error.reason}`,
  ]
  
  if (error.statusCode) {
    lines.push(`HTTP Status: ${error.statusCode}`)
  }
  
  if (error.circuitOpen) {
    lines.push('Note: This tool has failed multiple times and is temporarily disabled.')
  }
  
  lines.push('')
  lines.push(`Suggestion: ${error.suggestion}`)
  
  return lines.join('\n')
}
