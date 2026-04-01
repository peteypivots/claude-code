/**
 * Fallback provider router: tries primary provider, falls back to secondary
 * Supports local-first strategy (Ollama primary, Anthropic fallback)
 */

import {
  type ILLMProvider,
  type LLMProvider,
  type LLMRequestOptions,
  type LLMResponse,
  type LLMStreamEvent,
  ProviderError,
} from './types.js'

export interface FallbackConfig {
  primary: LLMProvider
  secondary?: LLMProvider
  logFallback?: (provider: LLMProvider, reason: string) => void
  enableFallback?: boolean
}

const DEFAULT_CONFIG: FallbackConfig = {
  primary: 'ollama',
  secondary: undefined, // No default fallback - must be explicitly configured
  enableFallback: false,
}

export class FallbackProvider implements ILLMProvider {
  private config: FallbackConfig
  private providers: Map<LLMProvider, ILLMProvider>
  private usedFallback = false
  private currentProvider: LLMProvider

  constructor(
    providers: Map<LLMProvider, ILLMProvider>,
    config: Partial<FallbackConfig> = {},
  ) {
    this.config = { ...DEFAULT_CONFIG, ...config }
    this.providers = providers
    this.currentProvider = this.config.primary
  }

  getName() {
    return this.currentProvider
  }

  async isAvailable(): Promise<boolean> {
    const primaryProvider = this.providers.get(this.config.primary)
    if (!primaryProvider) return false

    const available = await primaryProvider.isAvailable()
    if (available) {
      this.currentProvider = this.config.primary
      this.usedFallback = false
      return true
    }

    if (
      this.config.secondary &&
      this.config.enableFallback &&
      this.config.secondary !== this.config.primary
    ) {
      const secondaryProvider = this.providers.get(this.config.secondary)
      if (!secondaryProvider) return false

      const secondaryAvailable = await secondaryProvider.isAvailable()
      if (secondaryAvailable) {
        this.currentProvider = this.config.secondary
        this.usedFallback = true
        this.config.logFallback?.(
          this.config.secondary,
          'Primary provider unavailable',
        )
        return true
      }
    }

    return false
  }

  async complete(options: LLMRequestOptions): Promise<LLMResponse> {
    const primaryProvider = this.providers.get(this.config.primary)
    if (!primaryProvider) {
      throw new ProviderError(
        this.config.primary,
        'Primary provider not configured',
      )
    }

    try {
      const response = await primaryProvider.complete(options)
      this.currentProvider = this.config.primary
      this.usedFallback = false
      return response
    } catch (primaryError) {
      if (
        !this.config.secondary ||
        !this.config.enableFallback ||
        this.config.secondary === this.config.primary
      ) {
        throw primaryError
      }

      const secondaryProvider = this.providers.get(this.config.secondary)
      if (!secondaryProvider) {
        throw primaryError
      }

      this.config.logFallback?.(
        this.config.secondary,
        `Primary failed: ${(primaryError as Error).message}`,
      )

      try {
        const response = await secondaryProvider.complete(options)
        this.currentProvider = this.config.secondary
        this.usedFallback = true
        return response
      } catch (secondaryError) {
        throw new ProviderError(
          this.config.secondary,
          `All providers failed. Primary: ${(primaryError as Error).message}. Secondary: ${(secondaryError as Error).message}`,
          'ALL_PROVIDERS_FAILED',
        )
      }
    }
  }

  async *stream(
    options: LLMRequestOptions,
  ): AsyncGenerator<LLMStreamEvent, void, unknown> {
    const primaryProvider = this.providers.get(this.config.primary)
    if (!primaryProvider) {
      throw new ProviderError(
        this.config.primary,
        'Primary provider not configured',
      )
    }

    let primaryError: Error | undefined

    try {
      for await (const event of primaryProvider.stream(options)) {
        this.currentProvider = this.config.primary
        this.usedFallback = false
        yield event
      }
      return
    } catch (error) {
      primaryError = error instanceof Error ? error : new Error(String(error))
    }

    if (
      !this.config.secondary ||
      !this.config.enableFallback ||
      this.config.secondary === this.config.primary
    ) {
      throw primaryError
    }

    const secondaryProvider = this.providers.get(this.config.secondary)
    if (!secondaryProvider) {
      throw primaryError
    }

    this.config.logFallback?.(
      this.config.secondary,
      `Primary stream failed: ${primaryError.message}`,
    )

    try {
      for await (const event of secondaryProvider.stream(options)) {
        this.currentProvider = this.config.secondary
        this.usedFallback = true
        yield event
      }
    } catch (secondaryError) {
      throw new ProviderError(
        this.config.secondary,
        `Stream from all providers failed. Primary: ${primaryError.message}. Secondary: ${(secondaryError as Error).message}`,
        'ALL_PROVIDERS_FAILED',
      )
    }
  }

  getErrorContext(): string {
    const primary = this.providers.get(this.config.primary)
    const secondary = this.providers.get(this.config.secondary || 'anthropic')

    const contexts = [primary?.getErrorContext()]
    if (secondary) {
      contexts.push(secondary.getErrorContext())
    }

    return contexts.filter(Boolean).join(' | ')
  }

  isUsingFallback(): boolean {
    return this.usedFallback && this.currentProvider !== this.config.primary
  }

  getCurrentProvider(): LLMProvider {
    return this.currentProvider
  }
}
