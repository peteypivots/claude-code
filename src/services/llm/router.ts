/**
 * LLM Provider Factory and Router
 * Manages provider initialization and selection
 */

import { logError } from 'src/utils/log.js'
import { logForDebugging } from 'src/utils/debug.js'
import {
  type ILLMProvider,
  type LLMProvider,
  type LLMRequestOptions,
  type LLMResponse,
  type LLMStreamEvent,
} from './types.js'
import { AnthropicProvider } from './anthropicProvider.js'
import { OllamaProvider } from './ollamaClient.js'
import type { FallbackConfig } from './providerFallback.js'
import { FallbackProvider } from './providerFallback.js'

export interface RouterConfig {
  primaryProvider?: LLMProvider
  secondaryProvider?: LLMProvider
  enableFallback?: boolean
  ollamaBaseUrl?: string
  ollamaTimeout?: number
  anthropicApiKey?: string
  logProvider?: boolean
}

/**
 * Check if we have a valid Anthropic API key (not placeholder/missing)
 */
function hasValidAnthropicKey(): boolean {
  const key = process.env.ANTHROPIC_API_KEY
  return !!key && !key.includes('YOUR_API_KEY') && key.length > 10
}

const CONFIG_DEFAULTS: RouterConfig = {
  primaryProvider: process.env.LLM_PRIMARY_PROVIDER
    ? (process.env.LLM_PRIMARY_PROVIDER as LLMProvider)
    : 'ollama',
  // Only use Anthropic as secondary if we have a valid key
  secondaryProvider: process.env.LLM_SECONDARY_PROVIDER
    ? (process.env.LLM_SECONDARY_PROVIDER as LLMProvider)
    : hasValidAnthropicKey() ? 'anthropic' : undefined,
  // Disable fallback if no valid secondary provider key
  enableFallback: process.env.LLM_ENABLE_FALLBACK !== 'false' && hasValidAnthropicKey(),
  ollamaBaseUrl: process.env.OLLAMA_BASE_URL || 'http://localhost:11434',
  ollamaTimeout: parseInt(process.env.OLLAMA_TIMEOUT || '120000', 10),
  anthropicApiKey: process.env.ANTHROPIC_API_KEY,
  logProvider: process.env.LLM_LOG_PROVIDER === 'true',
}

/**
 * LLM Router manages provider selection and fallback orchestration
 */
export class LLMRouter implements ILLMProvider {
  private router: FallbackProvider
  private config: RouterConfig
  private providers: Map<LLMProvider, ILLMProvider>

  constructor(config: RouterConfig = {}) {
    this.config = { ...CONFIG_DEFAULTS, ...config }
    this.providers = new Map()

    // Initialize providers
    this.providers.set('ollama', new OllamaProvider({
      baseUrl: this.config.ollamaBaseUrl,
      timeout: this.config.ollamaTimeout,
    }))

    // Only create Anthropic provider if we have a valid key
    if (hasValidAnthropicKey()) {
      this.providers.set('anthropic', new AnthropicProvider({
        apiKey: this.config.anthropicApiKey,
      }))
    }

    // Create fallback router - don't default secondary to 'anthropic'
    this.router = new FallbackProvider(this.providers, {
      primary: this.config.primaryProvider || 'ollama',
      secondary: this.config.secondaryProvider, // undefined if no valid key
      enableFallback: this.config.enableFallback ?? false,
      logFallback: (provider, reason) => {
        if (this.config.logProvider) {
          logError(`Switched to ${provider} provider: ${reason}`)
        }
      },
    })

    if (this.config.logProvider) {
      logForDebugging(
        `LLMRouter initialized: primary=${this.config.primaryProvider}, secondary=${this.config.secondaryProvider}, fallback=${this.config.enableFallback}`,
        { level: 'debug' },
      )
    }
  }

  getName(): LLMProvider {
    return this.router.getName()
  }

  async isAvailable(): Promise<boolean> {
    return this.router.isAvailable()
  }

  async complete(options: LLMRequestOptions): Promise<LLMResponse> {
    if (this.config.logProvider) {
      logForDebugging(
        `LLMRouter.complete: model=${options.model}, provider=${this.router.getName()}`,
        { level: 'debug' },
      )
    }
    return this.router.complete(options)
  }

  async *stream(
    options: LLMRequestOptions,
  ): AsyncGenerator<LLMStreamEvent, void, unknown> {
    // Always log LLMRouter.stream calls for debugging
    const toolCount = options.tools?.length || 0
    console.error(`[LLMRouter] stream() called: model=${options.model}, tools=${toolCount}`)
    
    if (this.config.logProvider) {
      logForDebugging(
        `LLMRouter.stream: model=${options.model}, provider=${this.router.getName()}`,
        { level: 'debug' },
      )
    }
    for await (const event of this.router.stream(options)) {
      yield event
    }
  }

  getErrorContext(): string {
    return this.router.getErrorContext()
  }

  /**
   * Get the currently active provider
   */
  getCurrentProvider(): LLMProvider {
    return this.router.getCurrentProvider()
  }

  /**
   * Check if currently using fallback provider
   */
  isUsingFallback(): boolean {
    return this.router.isUsingFallback()
  }

  /**
   * Get status of all configured providers
   */
  async getProviderStatus(): Promise<
    Record<LLMProvider, { available: boolean; error?: string }>
  > {
    const status: Record<
      LLMProvider,
      { available: boolean; error?: string }
    > = {}

    for (const [name, provider] of this.providers) {
      const available = await provider.isAvailable()
      status[name] = {
        available,
        error: available ? undefined : provider.getErrorContext(),
      }
    }

    return status
  }
}

// Singleton instance
let globalRouter: LLMRouter | undefined

/**
 * Get or create the global LLM router instance
 */
export function getGlobalLLMRouter(config?: RouterConfig): LLMRouter {
  if (!globalRouter) {
    globalRouter = new LLMRouter(config)
  }
  return globalRouter
}

/**
 * Reset the global router (mainly for testing)
 */
export function resetGlobalLLMRouter(): void {
  globalRouter = undefined
}
