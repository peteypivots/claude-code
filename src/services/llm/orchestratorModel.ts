/**
 * Orchestrator Model - Small LLM for routing decisions
 * 
 * Uses a fast 3B model to decide:
 * 1. Should this go to local model, reasoning tool, or Claude?
 * 2. What tool should be called first?
 * 3. Is the task complex enough to warrant escalation?
 * 
 * Includes caching to avoid repeated routing calls for similar queries.
 */

import { createHash } from 'crypto'
import { OllamaProvider } from './ollamaClient.js'
import {
  type RoutingContext,
  type RoutingDecision,
  ROUTING_SYSTEM_PROMPT,
  buildRoutingPrompt,
  buildFewShotExamples,
  parseRoutingResponse,
} from './routingPrompt.js'

// ============================================================================
// Configuration
// ============================================================================

export interface OrchestratorConfig {
  /** Model to use for routing (default: qwen2.5:3b-instruct) */
  model: string
  /** Ollama base URL */
  baseUrl: string
  /** Cache TTL in milliseconds (default: 5 minutes) */
  cacheTtlMs: number
  /** Enable verbose logging */
  verbose: boolean
  /** Timeout for routing call (default: 5000ms - we want this fast) */
  timeout: number
  /** Base temperature for routing (default: 0 = deterministic) */
  temperature: number
  /** Temperature increment per retry (default: 0.2) */
  temperatureStep: number
  /** Maximum temperature (default: 0.7) */
  maxTemperature: number
}

const DEFAULT_CONFIG: OrchestratorConfig = {
  model: process.env.ORCHESTRATOR_MODEL || 'qwen2.5:3b-instruct',
  baseUrl: process.env.OLLAMA_BASE_URL || 'http://localhost:11434',
  cacheTtlMs: parseInt(process.env.ROUTER_CACHE_TTL_MS || '300000', 10), // 5 minutes
  verbose: process.env.ROUTER_VERBOSE === 'true',
  timeout: parseInt(process.env.ROUTER_TIMEOUT_MS || '5000', 10),
  temperature: parseFloat(process.env.ORCHESTRATOR_TEMPERATURE || '0'),
  temperatureStep: parseFloat(process.env.ORCHESTRATOR_TEMP_STEP || '0.2'),
  maxTemperature: parseFloat(process.env.ORCHESTRATOR_MAX_TEMP || '0.7'),
}

// ============================================================================
// Routing Cache
// ============================================================================

interface CacheEntry {
  decision: RoutingDecision
  expires: number
}

const routingCache = new Map<string, CacheEntry>()

/**
 * Generate cache key from routing context
 */
function getCacheKey(context: RoutingContext): string {
  const payload = {
    message: context.userMessage.slice(0, 500), // First 500 chars
    toolCount: context.toolCount,
    depth: context.conversationDepth,
  }
  return createHash('sha256').update(JSON.stringify(payload)).digest('hex').slice(0, 16)
}

/**
 * Get cached routing decision if available and not expired
 */
function getCached(key: string, config: OrchestratorConfig): RoutingDecision | null {
  const entry = routingCache.get(key)
  if (!entry) return null
  
  if (Date.now() > entry.expires) {
    routingCache.delete(key)
    return null
  }
  
  if (config.verbose) {
    console.log(`[Orchestrator] Cache HIT for key ${key}`)
  }
  
  return entry.decision
}

/**
 * Store routing decision in cache
 */
function setCache(key: string, decision: RoutingDecision, config: OrchestratorConfig): void {
  routingCache.set(key, {
    decision,
    expires: Date.now() + config.cacheTtlMs,
  })
  
  // Prune old entries (simple LRU-ish behavior)
  if (routingCache.size > 1000) {
    const oldest = routingCache.keys().next().value
    if (oldest) routingCache.delete(oldest)
  }
}

/**
 * Clear the routing cache
 */
export function clearRoutingCache(): void {
  routingCache.clear()
}

/**
 * Get cache statistics
 */
export function getCacheStats(): { size: number; ttlMs: number } {
  return {
    size: routingCache.size,
    ttlMs: DEFAULT_CONFIG.cacheTtlMs,
  }
}

// ============================================================================
// Orchestrator
// ============================================================================

// Singleton provider for orchestrator
let orchestratorProvider: OllamaProvider | null = null

function getOrchestratorProvider(config: OrchestratorConfig): OllamaProvider {
  if (!orchestratorProvider) {
    orchestratorProvider = new OllamaProvider({
      baseUrl: config.baseUrl,
      timeout: config.timeout,
      retries: 1, // Fast fail for routing
    })
  }
  return orchestratorProvider
}

/**
 * Get routing decision from orchestrator model
 * 
 * Uses cache when available, falls back to static rules on failure.
 * 
 * @param context - Routing context with user message, tool count, etc.
 * @param config - Orchestrator config overrides
 * @param retryCount - Number of retries (increases temperature adaptively)
 */
export async function getRoutingDecision(
  context: RoutingContext,
  config: Partial<OrchestratorConfig> = {},
  retryCount = 0,
): Promise<RoutingDecision> {
  const fullConfig = { ...DEFAULT_CONFIG, ...config }
  
  // Calculate adaptive temperature based on retry count
  const adaptiveTemp = Math.min(
    fullConfig.temperature + (retryCount * fullConfig.temperatureStep),
    fullConfig.maxTemperature
  )
  
  // Skip cache on retries (non-zero temperature means we want variety)
  if (retryCount === 0 && adaptiveTemp === 0) {
    const cacheKey = getCacheKey(context)
    const cached = getCached(cacheKey, fullConfig)
    if (cached) {
      return cached
    }
  }

  try {
    const decision = await callOrchestrator(context, fullConfig, adaptiveTemp)
    
    // Only cache deterministic (temperature=0) decisions
    if (adaptiveTemp === 0) {
      const cacheKey = getCacheKey(context)
      setCache(cacheKey, decision, fullConfig)
    }
    
    if (fullConfig.verbose && retryCount > 0) {
      console.log(`[Orchestrator] Retry #${retryCount} with temperature=${adaptiveTemp.toFixed(2)}`)
    }
    
    return decision
  } catch (error) {
    if (fullConfig.verbose) {
      console.warn('[Orchestrator] LLM routing failed, using static rules:', error)
    }
    // Fall back to static rules
    return getStaticRoutingDecision(context)
  }
}

/**
 * Call the orchestrator model for a routing decision
 * 
 * @param context - Routing context
 * @param config - Orchestrator config
 * @param temperature - Temperature for this call (0 = deterministic, higher = more creative)
 */
async function callOrchestrator(
  context: RoutingContext,
  config: OrchestratorConfig,
  temperature = 0,
): Promise<RoutingDecision> {
  const provider = getOrchestratorProvider(config)
  
  // Build the prompt with few-shot examples
  const fewShot = buildFewShotExamples()
  const userPrompt = buildRoutingPrompt(context)
  
  const fullPrompt = `${fewShot}\n\n---\n\n${userPrompt}`

  if (config.verbose) {
    console.log(`[Orchestrator] Calling ${config.model} for routing decision (temp=${temperature.toFixed(2)})...`)
  }

  const startTime = Date.now()
  
  const response = await provider.complete({
    model: config.model,
    messages: [{ role: 'user', content: fullPrompt }],
    systemPrompt: ROUTING_SYSTEM_PROMPT,
    maxTokens: 150, // Routing decisions should be short
    temperature, // Adaptive temperature: 0 = deterministic, higher = more creative on retries
  })

  const elapsed = Date.now() - startTime
  
  // Extract response text
  const responseText = response.content
    .filter(c => c.type === 'text')
    .map(c => c.text || '')
    .join('')

  if (config.verbose) {
    console.log(`[Orchestrator] Response (${elapsed}ms): ${responseText}`)
  }

  // Parse the response
  const decision = parseRoutingResponse(responseText)
  
  if (!decision) {
    throw new Error(`Failed to parse routing response: ${responseText}`)
  }

  return decision
}

// ============================================================================
// Static Fallback Rules
// ============================================================================

/**
 * Static routing rules as fallback when orchestrator fails
 * These are the same rules from the original queryModelRouter
 */
function getStaticRoutingDecision(context: RoutingContext): RoutingDecision {
  const message = context.userMessage.toLowerCase()
  
  // Escalation keywords
  const escalationKeywords = [
    'architect', 'security review', 'comprehensive', 'refactor entire',
    'design pattern', 'full implementation', 'explain in detail',
  ]
  
  if (escalationKeywords.some(kw => message.includes(kw))) {
    return {
      action: 'escalate',
      model: 'claude-sonnet-4-20250514',
      reasoning: 'Escalation keyword detected',
      confidence: 0.8,
    }
  }

  // Reasoning keywords
  const reasoningKeywords = [
    'calculate', 'probability', 'optimal', 'best way to',
    'step by step', 'analyze', 'compare',
  ]
  
  if (reasoningKeywords.some(kw => message.includes(kw))) {
    return {
      action: 'reason',
      model: 'deepseek-r1:7b',
      reasoning: 'Reasoning keyword detected',
      confidence: 0.75,
    }
  }

  // Complexity thresholds
  if (context.userMessage.length > 8000) {
    return {
      action: 'escalate',
      model: 'claude-sonnet-4-20250514',
      reasoning: 'Long input exceeds complexity threshold',
      confidence: 0.7,
    }
  }

  if (context.toolCount > 20) {
    return {
      action: 'escalate',
      model: 'claude-sonnet-4-20250514',
      reasoning: 'Many tools require stronger orchestration',
      confidence: 0.65,
    }
  }

  if (context.conversationDepth > 25) {
    return {
      action: 'escalate',
      model: 'claude-sonnet-4-20250514',
      reasoning: 'Deep conversation may need coherence from stronger model',
      confidence: 0.6,
    }
  }

  // Default to local
  return {
    action: 'local',
    model: process.env.LOCAL_MODEL || 'qwen2.5:7b-instruct',
    reasoning: 'Default to local model',
    confidence: 0.9,
  }
}

// ============================================================================
// Health Check
// ============================================================================

/**
 * Check if orchestrator is available
 */
export async function isOrchestratorAvailable(
  config: Partial<OrchestratorConfig> = {},
): Promise<boolean> {
  const fullConfig = { ...DEFAULT_CONFIG, ...config }
  const provider = getOrchestratorProvider(fullConfig)
  return provider.isAvailable()
}

// ============================================================================
// Exports
// ============================================================================

export {
  type RoutingContext,
  type RoutingDecision,
  DEFAULT_CONFIG as ORCHESTRATOR_CONFIG,
}
