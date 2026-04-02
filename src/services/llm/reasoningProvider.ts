/**
 * Reasoning Provider - DeepSeek-R1 Integration
 * 
 * Provides chain-of-thought reasoning as a service.
 * Called by the orchestrator when tasks require step-by-step analysis.
 * 
 * Features:
 * - Problem-type-based temperature selection
 * - Reasoning chain cache with TTL for reuse
 * - Similar-problem recall to bootstrap reasoning
 */

import { createHash } from 'crypto'
import { OllamaProvider } from './ollamaClient.js'
import type { LLMResponse } from './types.js'

// ============================================================================
// Types
// ============================================================================

/** Problem types with corresponding temperature settings */
export type ProblemType = 
  | 'math'       // Fully deterministic
  | 'logic'      // Deterministic
  | 'debugging'  // Slight creativity for edge cases
  | 'planning'   // Needs some creativity
  | 'analysis'   // Similar to planning
  | 'tradeoffs'  // Most creativity
  | 'general'    // Default

export interface ReasoningRequest {
  /** The problem to reason through */
  problem: string
  /** Type of problem (affects temperature selection) */
  problemType?: ProblemType
  /** Optional constraints to consider */
  constraints?: string[]
  /** Context from prior conversation */
  context?: string
  /** Maximum tokens for reasoning trace (default: 2048) */
  maxTokens?: number
  /** Override temperature (bypasses problem-type selection) */
  temperature?: number
  /** Skip cache lookup (force fresh reasoning) */
  skipCache?: boolean
}

export interface ReasoningResult {
  /** The final answer/conclusion */
  answer: string
  /** Full reasoning trace (chain-of-thought) */
  reasoning: string
  /** Confidence in the answer (0-1) */
  confidence: number
  /** Time taken in milliseconds */
  durationMs: number
  /** Token usage */
  usage: {
    inputTokens: number
    outputTokens: number
  }
  /** Whether this was served from cache */
  fromCache?: boolean
  /** Prior reasoning that influenced this result (if recalled) */
  priorContext?: string
}

export interface ReasoningConfig {
  /** Model to use (default: deepseek-r1:7b) */
  model: string
  /** Ollama base URL */
  baseUrl: string
  /** Timeout in ms (reasoning can take longer) */
  timeout: number
  /** Enable verbose logging */
  verbose: boolean
  /** Cache TTL in milliseconds (default: 30 minutes) */
  cacheTtlMs: number
  /** Base temperature for general problems */
  baseTemperature: number
  /** Enable caching */
  cacheEnabled: boolean
}

// ============================================================================
// Configuration
// ============================================================================

const DEFAULT_CONFIG: ReasoningConfig = {
  model: process.env.REASONING_MODEL || 'deepseek-r1:7b',
  baseUrl: process.env.OLLAMA_BASE_URL || 'http://localhost:11434',
  timeout: parseInt(process.env.REASONING_TIMEOUT_MS || '60000', 10),
  verbose: process.env.REASONING_VERBOSE === 'true',
  cacheTtlMs: parseInt(process.env.REASONING_CACHE_TTL_MS || '1800000', 10), // 30 minutes
  baseTemperature: parseFloat(process.env.REASONING_BASE_TEMP || '0.1'),
  cacheEnabled: process.env.REASONING_CACHE_ENABLED !== 'false',
}

/**
 * Temperature by problem type
 * - Lower = more deterministic (math, logic)
 * - Higher = more creative exploration (tradeoffs, planning)
 */
const PROBLEM_TYPE_TEMPS: Record<ProblemType, number> = {
  math: 0.0,        // Fully deterministic
  logic: 0.0,       // Deterministic
  debugging: 0.1,   // Slight creativity for edge cases
  planning: 0.2,    // Needs some creativity
  analysis: 0.2,    // Similar to planning
  tradeoffs: 0.3,   // Most creativity
  general: parseFloat(process.env.REASONING_BASE_TEMP || '0.1'),
}

// ============================================================================
// Reasoning Cache
// ============================================================================

interface CacheEntry {
  result: ReasoningResult
  expires: number
  problemHash: string
}

const reasoningCache = new Map<string, CacheEntry>()

/**
 * Generate cache key from problem and type
 */
function getCacheKey(problem: string, problemType?: ProblemType): string {
  const payload = {
    problem: problem.slice(0, 1000), // First 1000 chars
    type: problemType || 'general',
  }
  return createHash('sha256').update(JSON.stringify(payload)).digest('hex').slice(0, 16)
}

/**
 * Get cached reasoning result if available and not expired
 */
function getCached(key: string, config: ReasoningConfig): ReasoningResult | null {
  if (!config.cacheEnabled) return null
  
  const entry = reasoningCache.get(key)
  if (!entry) return null
  
  if (Date.now() > entry.expires) {
    reasoningCache.delete(key)
    return null
  }
  
  if (config.verbose) {
    console.log(`[Reasoning] Cache HIT for key ${key}`)
  }
  
  return entry.result
}

/**
 * Store reasoning result in cache
 */
function setCache(key: string, result: ReasoningResult, config: ReasoningConfig): void {
  if (!config.cacheEnabled) return
  
  reasoningCache.set(key, {
    result,
    expires: Date.now() + config.cacheTtlMs,
    problemHash: key,
  })
  
  // Prune old entries (simple LRU-ish behavior)
  if (reasoningCache.size > 500) {
    const oldest = reasoningCache.keys().next().value
    if (oldest) reasoningCache.delete(oldest)
  }
  
  if (config.verbose) {
    console.log(`[Reasoning] Cached result for key ${key} (${reasoningCache.size} entries)`)
  }
}

/**
 * Clear the reasoning cache
 */
export function clearReasoningCache(): void {
  reasoningCache.clear()
}

/**
 * Get cache statistics
 */
export function getReasoningCacheStats(): { size: number; ttlMs: number } {
  return {
    size: reasoningCache.size,
    ttlMs: DEFAULT_CONFIG.cacheTtlMs,
  }
}

/**
 * Recall prior reasoning for a similar problem
 * Returns the reasoning chain and confidence if a high-confidence match exists
 */
export function recallSimilarReasoning(
  problem: string,
  problemType?: ProblemType,
): { reasoning: string; confidence: number } | null {
  const key = getCacheKey(problem, problemType)
  const entry = reasoningCache.get(key)
  
  if (entry && Date.now() < entry.expires && entry.result.confidence > 0.5) {
    return {
      reasoning: entry.result.reasoning,
      confidence: entry.result.confidence,
    }
  }
  return null
}

// ============================================================================
// Reasoning System Prompt
// ============================================================================

const REASONING_SYSTEM_PROMPT = `You are a careful reasoning assistant. Your job is to think through problems step by step.

APPROACH:
1. Understand what is being asked
2. Break down the problem into parts
3. Analyze each part carefully
4. Check your work
5. Provide a clear final answer

OUTPUT FORMAT:
<reasoning>
[Your step-by-step thinking process here]
</reasoning>

<answer>
[Your final answer here]
</answer>

<confidence>
[A number from 0.0 to 1.0 indicating your confidence]
</confidence>

Be thorough but efficient. Show your work.`

// ============================================================================
// Provider
// ============================================================================

let reasoningProvider: OllamaProvider | null = null

function getReasoningProvider(config: ReasoningConfig): OllamaProvider {
  if (!reasoningProvider) {
    reasoningProvider = new OllamaProvider({
      baseUrl: config.baseUrl,
      timeout: config.timeout,
      retries: 2,
    })
  }
  return reasoningProvider
}

// ============================================================================
// Main Function
// ============================================================================

/**
 * Run reasoning on a problem using DeepSeek-R1
 * 
 * Features:
 * - Automatic temperature selection based on problem type
 * - Cache lookup for previously solved problems
 * - Prior reasoning recall to bootstrap new problems
 */
export async function reason(
  request: ReasoningRequest,
  config: Partial<ReasoningConfig> = {},
): Promise<ReasoningResult> {
  const fullConfig = { ...DEFAULT_CONFIG, ...config }
  const provider = getReasoningProvider(fullConfig)

  // Check cache first (unless skipCache)
  if (!request.skipCache) {
    const cacheKey = getCacheKey(request.problem, request.problemType)
    const cached = getCached(cacheKey, fullConfig)
    if (cached) {
      return { ...cached, fromCache: true }
    }
  }

  // Determine temperature based on problem type (or use override)
  const temperature = request.temperature ?? PROBLEM_TYPE_TEMPS[request.problemType || 'general']

  // Check for similar prior reasoning to include as context
  let enhancedContext = request.context || ''
  let priorContext: string | undefined

  const priorReasoning = recallSimilarReasoning(request.problem, request.problemType)
  if (priorReasoning && priorReasoning.confidence > 0.6) {
    priorContext = `Similar problem solved before (confidence ${(priorReasoning.confidence * 100).toFixed(0)}%):\n${priorReasoning.reasoning.slice(0, 500)}\nAdapt this approach if relevant.`
    enhancedContext = enhancedContext
      ? `${enhancedContext}\n\n${priorContext}`
      : priorContext
  }

  // Build the prompt
  const prompt = buildReasoningPrompt({
    ...request,
    context: enhancedContext,
  })

  if (fullConfig.verbose) {
    console.log(`[Reasoning] Starting reasoning with ${fullConfig.model}...`)
    console.log(`[Reasoning] Problem type: ${request.problemType || 'general'}, temp: ${temperature}`)
    console.log(`[Reasoning] Problem: ${request.problem.slice(0, 100)}...`)
    if (priorContext) {
      console.log(`[Reasoning] Using prior reasoning as context`)
    }
  }

  const startTime = Date.now()

  const response = await provider.complete({
    model: fullConfig.model,
    messages: [{ role: 'user', content: prompt }],
    systemPrompt: REASONING_SYSTEM_PROMPT,
    maxTokens: request.maxTokens ?? 2048,
    temperature,
  })

  const durationMs = Date.now() - startTime

  // Parse the response
  const result = parseReasoningResponse(response, durationMs)
  
  // Add prior context reference if used
  if (priorContext) {
    result.priorContext = priorContext
  }

  // Cache result (only if confidence > 0.5)
  if (result.confidence > 0.5) {
    const cacheKey = getCacheKey(request.problem, request.problemType)
    setCache(cacheKey, result, fullConfig)
  }

  if (fullConfig.verbose) {
    console.log(`[Reasoning] Completed in ${durationMs}ms`)
    console.log(`[Reasoning] Confidence: ${result.confidence}`)
  }

  return result
}

/**
 * Stream reasoning output (for real-time display of thinking)
 */
export async function* reasonStream(
  request: ReasoningRequest,
  config: Partial<ReasoningConfig> = {},
): AsyncGenerator<{ type: 'reasoning' | 'answer' | 'done'; text: string }> {
  const fullConfig = { ...DEFAULT_CONFIG, ...config }
  const provider = getReasoningProvider(fullConfig)

  // Determine temperature based on problem type (or use override)
  const temperature = request.temperature ?? PROBLEM_TYPE_TEMPS[request.problemType || 'general']

  const prompt = buildReasoningPrompt(request)

  let buffer = ''
  let inReasoning = false
  let inAnswer = false

  for await (const event of provider.stream({
    model: fullConfig.model,
    messages: [{ role: 'user', content: prompt }],
    systemPrompt: REASONING_SYSTEM_PROMPT,
    maxTokens: request.maxTokens ?? 2048,
    temperature,
  })) {
    if (event.type === 'content_block_delta' && event.delta?.text) {
      buffer += event.delta.text

      // Check for section transitions
      if (buffer.includes('<reasoning>') && !inReasoning) {
        inReasoning = true
        buffer = buffer.split('<reasoning>')[1] || ''
      }

      if (buffer.includes('</reasoning>') && inReasoning) {
        const [reasoningPart] = buffer.split('</reasoning>')
        yield { type: 'reasoning', text: reasoningPart }
        buffer = buffer.split('</reasoning>')[1] || ''
        inReasoning = false
      }

      if (buffer.includes('<answer>') && !inAnswer) {
        inAnswer = true
        buffer = buffer.split('<answer>')[1] || ''
      }

      if (buffer.includes('</answer>') && inAnswer) {
        const [answerPart] = buffer.split('</answer>')
        yield { type: 'answer', text: answerPart }
        buffer = buffer.split('</answer>')[1] || ''
        inAnswer = false
      }

      // Yield partial reasoning as it comes
      if (inReasoning && buffer.length > 50) {
        yield { type: 'reasoning', text: buffer }
        buffer = ''
      }
    }

    if (event.type === 'message_stop') {
      yield { type: 'done', text: '' }
    }
  }
}

// ============================================================================
// Helpers
// ============================================================================

/**
 * Build the prompt for reasoning
 */
function buildReasoningPrompt(request: ReasoningRequest): string {
  const parts: string[] = []

  if (request.context) {
    parts.push('CONTEXT:')
    parts.push(request.context)
    parts.push('')
  }

  parts.push('PROBLEM:')
  parts.push(request.problem)

  if (request.constraints && request.constraints.length > 0) {
    parts.push('')
    parts.push('CONSTRAINTS:')
    for (const constraint of request.constraints) {
      parts.push(`- ${constraint}`)
    }
  }

  parts.push('')
  parts.push('Think through this step by step and provide your answer.')

  return parts.join('\n')
}

/**
 * Parse the reasoning response
 */
function parseReasoningResponse(response: LLMResponse, durationMs: number): ReasoningResult {
  const text = response.content
    .filter(c => c.type === 'text')
    .map(c => c.text || '')
    .join('')

  // Extract reasoning
  const reasoningMatch = text.match(/<reasoning>([\s\S]*?)<\/reasoning>/i)
  const reasoning = reasoningMatch?.[1]?.trim() || text

  // Extract answer
  const answerMatch = text.match(/<answer>([\s\S]*?)<\/answer>/i)
  const answer = answerMatch?.[1]?.trim() || extractFinalAnswer(text)

  // Extract confidence
  const confidenceMatch = text.match(/<confidence>([\d.]+)<\/confidence>/i)
  const confidence = confidenceMatch ? parseFloat(confidenceMatch[1]) : 0.7

  return {
    answer,
    reasoning,
    confidence: Math.min(1, Math.max(0, confidence)),
    durationMs,
    usage: response.usage,
  }
}

/**
 * Extract final answer when XML tags aren't present
 */
function extractFinalAnswer(text: string): string {
  // Look for common answer patterns
  const patterns = [
    /(?:therefore|thus|so|hence|finally|in conclusion)[,:]?\s*(.+?)(?:\.|$)/i,
    /(?:the answer is|answer:)\s*(.+?)(?:\.|$)/i,
    /(?:result:)\s*(.+?)(?:\.|$)/i,
  ]

  for (const pattern of patterns) {
    const match = text.match(pattern)
    if (match) {
      return match[1].trim()
    }
  }

  // Fall back to last sentence
  const sentences = text.split(/[.!?]+/).filter(s => s.trim())
  return sentences[sentences.length - 1]?.trim() || text.slice(-200)
}

// ============================================================================
// Health Check
// ============================================================================

/**
 * Check if reasoning model is available
 */
export async function isReasoningAvailable(
  config: Partial<ReasoningConfig> = {},
): Promise<boolean> {
  const fullConfig = { ...DEFAULT_CONFIG, ...config }
  const provider = getReasoningProvider(fullConfig)
  
  try {
    const available = await provider.isAvailable()
    if (!available) return false

    // Check if specific model is loaded
    const response = await fetch(`${fullConfig.baseUrl}/api/tags`)
    if (!response.ok) return false
    
    const data = await response.json() as { models: Array<{ name: string }> }
    return data.models.some(m => m.name.includes('deepseek-r1') || m.name.includes('r1'))
  } catch {
    return false
  }
}

// ============================================================================
// Exports
// ============================================================================

export { DEFAULT_CONFIG as REASONING_CONFIG, PROBLEM_TYPE_TEMPS }
