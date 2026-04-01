/**
 * Model Pool - Multi-Model Registry and Health Management
 * 
 * Manages the compound AI system's model tiers:
 * - Orchestrator (3B): Fast routing decisions
 * - Worker (7B): General task execution
 * - Reasoner (R1-7B): Step-by-step reasoning
 * - Specialist (Claude): Complex/creative tasks
 */

import { OllamaProvider } from './ollamaClient.js'
import type { ILLMProvider, LLMProvider } from './types.js'

// ============================================================================
// Types
// ============================================================================

export type ModelTier = 'orchestrator' | 'worker' | 'reasoner' | 'specialist'

export interface ModelConfig {
  /** Display name */
  name: string
  /** Ollama model ID (for local) or Claude model ID */
  modelId: string
  /** Which provider to use */
  provider: LLMProvider
  /** Default timeout in ms */
  timeout: number
  /** Max retries on failure */
  retries: number
  /** Is this model currently healthy? */
  healthy: boolean
  /** Last health check timestamp */
  lastCheck: number
  /** Tier this model belongs to */
  tier: ModelTier
}

export interface PoolConfig {
  /** Ollama base URL */
  ollamaBaseUrl: string
  /** Health check interval in ms (default: 60000 = 1 minute) */
  healthCheckInterval: number
  /** Enable automatic fallback on failure */
  autoFallback: boolean
  /** Verbose logging */
  verbose: boolean
}

// ============================================================================
// Default Configuration
// ============================================================================

const DEFAULT_POOL_CONFIG: PoolConfig = {
  ollamaBaseUrl: process.env.OLLAMA_BASE_URL || 'http://localhost:11434',
  healthCheckInterval: parseInt(process.env.POOL_HEALTH_INTERVAL_MS || '60000', 10),
  autoFallback: process.env.POOL_AUTO_FALLBACK !== 'false',
  verbose: process.env.POOL_VERBOSE === 'true',
}

// Default model pool
const DEFAULT_MODELS: Record<ModelTier, ModelConfig> = {
  orchestrator: {
    name: 'Orchestrator',
    modelId: process.env.ORCHESTRATOR_MODEL || 'qwen2.5:3b-instruct',
    provider: 'ollama',
    timeout: 5000,  // Must be fast
    retries: 1,
    healthy: true,
    lastCheck: 0,
    tier: 'orchestrator',
  },
  worker: {
    name: 'Worker',
    modelId: process.env.LOCAL_MODEL || 'qwen2.5:7b-instruct',
    provider: 'ollama',
    timeout: 30000,
    retries: 2,
    healthy: true,
    lastCheck: 0,
    tier: 'worker',
  },
  reasoner: {
    name: 'Reasoner',
    modelId: process.env.REASONING_MODEL || 'deepseek-r1:7b',
    provider: 'ollama',
    timeout: 60000,  // Reasoning takes longer
    retries: 2,
    healthy: true,
    lastCheck: 0,
    tier: 'reasoner',
  },
  specialist: {
    name: 'Specialist',
    modelId: process.env.ESCALATION_MODEL || 'claude-sonnet-4-20250514',
    provider: 'anthropic',
    timeout: 120000,
    retries: 3,
    healthy: true,
    lastCheck: 0,
    tier: 'specialist',
  },
}

// ============================================================================
// Model Pool Class
// ============================================================================

export class ModelPool {
  private models: Map<ModelTier, ModelConfig>
  private providers: Map<string, ILLMProvider>
  private config: PoolConfig
  private healthCheckTimer: NodeJS.Timeout | null = null

  constructor(config: Partial<PoolConfig> = {}) {
    this.config = { ...DEFAULT_POOL_CONFIG, ...config }
    this.models = new Map(Object.entries(DEFAULT_MODELS) as Array<[ModelTier, ModelConfig]>)
    this.providers = new Map()
  }

  // --------------------------------------------------------------------------
  // Provider Access
  // --------------------------------------------------------------------------

  /**
   * Get provider for a specific tier
   */
  getProvider(tier: ModelTier): ILLMProvider {
    const modelConfig = this.models.get(tier)
    if (!modelConfig) {
      throw new Error(`Unknown model tier: ${tier}`)
    }

    const cacheKey = `${modelConfig.provider}-${modelConfig.modelId}`
    
    if (!this.providers.has(cacheKey)) {
      const provider = this.createProvider(modelConfig)
      this.providers.set(cacheKey, provider)
    }

    return this.providers.get(cacheKey)!
  }

  /**
   * Get the model ID for a tier
   */
  getModelId(tier: ModelTier): string {
    return this.models.get(tier)?.modelId || DEFAULT_MODELS[tier].modelId
  }

  /**
   * Get model config for a tier
   */
  getModelConfig(tier: ModelTier): ModelConfig | undefined {
    return this.models.get(tier)
  }

  /**
   * Check if a tier is healthy
   */
  isHealthy(tier: ModelTier): boolean {
    return this.models.get(tier)?.healthy ?? false
  }

  // --------------------------------------------------------------------------
  // Model Configuration
  // --------------------------------------------------------------------------

  /**
   * Override a model for a tier
   */
  setModel(tier: ModelTier, modelId: string, provider: LLMProvider = 'ollama'): void {
    const existing = this.models.get(tier)
    if (existing) {
      existing.modelId = modelId
      existing.provider = provider
      existing.healthy = true  // Assume healthy until checked
      existing.lastCheck = 0
      
      // Clear cached provider
      const cacheKey = `${existing.provider}-${existing.modelId}`
      this.providers.delete(cacheKey)
    }

    if (this.config.verbose) {
      console.log(`[ModelPool] Set ${tier} to ${modelId} (${provider})`)
    }
  }

  /**
   * Get fallback tier for a given tier
   */
  getFallback(tier: ModelTier): ModelTier | null {
    const fallbacks: Record<ModelTier, ModelTier | null> = {
      orchestrator: 'worker',      // If 3B fails, try 7B
      worker: 'specialist',        // If local fails, try Claude
      reasoner: 'specialist',      // If R1 fails, try Claude
      specialist: null,            // No fallback for Claude
    }
    return fallbacks[tier]
  }

  // --------------------------------------------------------------------------
  // Health Checks
  // --------------------------------------------------------------------------

  /**
   * Check health of all models
   */
  async checkHealth(): Promise<Map<ModelTier, boolean>> {
    const results = new Map<ModelTier, boolean>()

    for (const [tier, config] of this.models) {
      try {
        const provider = this.getProvider(tier)
        const healthy = await provider.isAvailable()
        
        config.healthy = healthy
        config.lastCheck = Date.now()
        results.set(tier, healthy)

        if (this.config.verbose) {
          console.log(`[ModelPool] Health check ${tier}: ${healthy ? 'OK' : 'FAILED'}`)
        }
      } catch (error) {
        config.healthy = false
        config.lastCheck = Date.now()
        results.set(tier, false)

        if (this.config.verbose) {
          console.log(`[ModelPool] Health check ${tier}: ERROR - ${error}`)
        }
      }
    }

    return results
  }

  /**
   * Start periodic health checks
   */
  startHealthChecks(): void {
    if (this.healthCheckTimer) return

    this.healthCheckTimer = setInterval(
      () => void this.checkHealth(),
      this.config.healthCheckInterval,
    )

    // Initial check
    void this.checkHealth()
  }

  /**
   * Stop health checks
   */
  stopHealthChecks(): void {
    if (this.healthCheckTimer) {
      clearInterval(this.healthCheckTimer)
      this.healthCheckTimer = null
    }
  }

  // --------------------------------------------------------------------------
  // Pool Status
  // --------------------------------------------------------------------------

  /**
   * Get status of all models
   */
  getStatus(): Array<{
    tier: ModelTier
    name: string
    modelId: string
    provider: LLMProvider
    healthy: boolean
    lastCheck: Date | null
  }> {
    return Array.from(this.models.entries()).map(([tier, config]) => ({
      tier,
      name: config.name,
      modelId: config.modelId,
      provider: config.provider,
      healthy: config.healthy,
      lastCheck: config.lastCheck ? new Date(config.lastCheck) : null,
    }))
  }

  /**
   * Get count of healthy models
   */
  getHealthyCount(): number {
    return Array.from(this.models.values()).filter(m => m.healthy).length
  }

  /**
   * Check if local models are available (orchestrator + worker)
   */
  hasLocalCapability(): boolean {
    const orchestrator = this.models.get('orchestrator')
    const worker = this.models.get('worker')
    return (orchestrator?.healthy ?? false) && (worker?.healthy ?? false)
  }

  // --------------------------------------------------------------------------
  // Provider Factory
  // --------------------------------------------------------------------------

  private createProvider(config: ModelConfig): ILLMProvider {
    if (config.provider === 'ollama') {
      return new OllamaProvider({
        baseUrl: this.config.ollamaBaseUrl,
        timeout: config.timeout,
        retries: config.retries,
        model: config.modelId,
      })
    }

    // For Anthropic, create a lightweight provider
    // (Full integration will use the existing AnthropicProvider)
    return this.createAnthropicProvider(config)
  }

  private createAnthropicProvider(config: ModelConfig): ILLMProvider {
    return {
      getName: () => 'anthropic' as const,
      
      isAvailable: async () => !!process.env.ANTHROPIC_API_KEY,
      
      complete: async () => {
        // Placeholder - will integrate with existing queryModelWithStreaming
        throw new Error('Use queryModelWithStreaming for Anthropic calls')
      },

      stream: async function* () {
        throw new Error('Use queryModelWithStreaming for Anthropic calls')
      },

      getErrorContext: () => `Anthropic provider for ${config.name}`,
    }
  }
}

// ============================================================================
// Singleton Instance
// ============================================================================

let poolInstance: ModelPool | null = null

/**
 * Get the global model pool instance
 */
export function getModelPool(config?: Partial<PoolConfig>): ModelPool {
  if (!poolInstance || config) {
    poolInstance = new ModelPool(config)
  }
  return poolInstance
}

/**
 * Reset the global pool (for testing)
 */
export function resetModelPool(): void {
  if (poolInstance) {
    poolInstance.stopHealthChecks()
    poolInstance = null
  }
}

// ============================================================================
// Convenience Functions
// ============================================================================

/**
 * Get provider for a tier from global pool
 */
export function getProviderForTier(tier: ModelTier): ILLMProvider {
  return getModelPool().getProvider(tier)
}

/**
 * Get the best available model for a task
 * Falls back through tiers if needed
 */
export function getBestAvailableModel(
  preferredTier: ModelTier,
  pool: ModelPool = getModelPool(),
): { tier: ModelTier; modelId: string; provider: ILLMProvider } | null {
  let currentTier: ModelTier | null = preferredTier

  while (currentTier) {
    if (pool.isHealthy(currentTier)) {
      return {
        tier: currentTier,
        modelId: pool.getModelId(currentTier),
        provider: pool.getProvider(currentTier),
      }
    }
    currentTier = pool.getFallback(currentTier)
  }

  return null
}
