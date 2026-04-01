/**
 * Side Query Provider - Abstraction for lightweight LLM queries
 * 
 * Used by memory selection, quick classification, and other non-main-loop calls.
 * Inherits provider from parent context to preserve cache sharing.
 */

import { OllamaProvider, type OllamaConfig } from './ollamaClient.js'
import type { ILLMProvider, LLMRequestOptions, LLMResponse, LLMProvider } from './types.js'

// ============================================================================
// Types
// ============================================================================

export interface SideQueryOptions {
  /** The prompt to send */
  prompt: string
  /** System prompt (optional) */
  systemPrompt?: string
  /** Max tokens for response (default: 1024) */
  maxTokens?: number
  /** Model override (if not inheriting from context) */
  model?: string
  /** Temperature (default: 0) */
  temperature?: number
}

export interface SideQueryResult {
  text: string
  usage: {
    inputTokens: number
    outputTokens: number
  }
  model: string
  provider: LLMProvider
}

export interface ProviderContext {
  /** The active provider in the parent context */
  activeProvider?: LLMProvider
  /** Ollama config override */
  ollamaConfig?: Partial<OllamaConfig>
}

// ============================================================================
// Provider Registry
// ============================================================================

// Singleton providers (lazy initialized)
let ollamaProvider: OllamaProvider | null = null

function getOllamaProvider(config?: Partial<OllamaConfig>): OllamaProvider {
  if (!ollamaProvider || config) {
    ollamaProvider = new OllamaProvider(config)
  }
  return ollamaProvider
}

// Default models for side queries (lighter weight than main loop)
const SIDE_QUERY_MODELS: Record<LLMProvider, string> = {
  ollama: process.env.SIDE_QUERY_OLLAMA_MODEL || 'qwen2.5:3b-instruct',
  anthropic: process.env.SIDE_QUERY_ANTHROPIC_MODEL || 'claude-3-5-sonnet-20241022',
}

// ============================================================================
// Side Query Function
// ============================================================================

/**
 * Execute a side query using the appropriate provider.
 * 
 * Provider selection strategy:
 * 1. If context.activeProvider is set, use that (inherits from parent)
 * 2. If OLLAMA_BASE_URL is set, use Ollama
 * 3. Otherwise use Anthropic
 * 
 * This preserves cache sharing when the parent is on Claude,
 * while using Ollama when the parent is on Ollama.
 */
export async function sideQuery(
  options: SideQueryOptions,
  context: ProviderContext = {},
): Promise<SideQueryResult> {
  const provider = selectProvider(context)
  const model = options.model || SIDE_QUERY_MODELS[provider.getName()]

  const requestOptions: LLMRequestOptions = {
    model,
    messages: [
      {
        role: 'user',
        content: options.prompt,
      },
    ],
    maxTokens: options.maxTokens ?? 1024,
    systemPrompt: options.systemPrompt,
    temperature: options.temperature ?? 0,
  }

  try {
    const response = await provider.complete(requestOptions)
    
    // Extract text from response
    const text = response.content
      .filter(c => c.type === 'text')
      .map(c => c.text || '')
      .join('')

    return {
      text,
      usage: response.usage,
      model: response.model,
      provider: provider.getName(),
    }
  } catch (error) {
    // If Ollama fails, try to fall back to Anthropic if available
    if (provider.getName() === 'ollama' && process.env.ANTHROPIC_API_KEY) {
      console.warn('[sideQuery] Ollama failed, falling back to Anthropic:', error)
      return sideQuery(options, { ...context, activeProvider: 'anthropic' })
    }
    throw error
  }
}

/**
 * Select the appropriate provider based on context
 */
function selectProvider(context: ProviderContext): ILLMProvider {
  // 1. Inherit from parent context if specified
  if (context.activeProvider === 'ollama') {
    return getOllamaProvider(context.ollamaConfig)
  }
  
  if (context.activeProvider === 'anthropic') {
    // For now, return a lightweight Anthropic wrapper
    // This will be replaced with AnthropicProvider when integrated
    return createAnthropicSideQueryProvider()
  }

  // 2. Check environment for default provider
  if (process.env.OLLAMA_BASE_URL || process.env.LOCAL_FIRST === 'true') {
    return getOllamaProvider(context.ollamaConfig)
  }

  // 3. Default to Anthropic
  return createAnthropicSideQueryProvider()
}

// ============================================================================
// Anthropic Side Query Provider (Lightweight wrapper)
// ============================================================================

/**
 * Minimal Anthropic provider for side queries.
 * Uses direct API call instead of full SDK to reduce overhead.
 */
function createAnthropicSideQueryProvider(): ILLMProvider {
  return {
    getName: () => 'anthropic' as const,
    
    isAvailable: async () => {
      return !!process.env.ANTHROPIC_API_KEY
    },
    
    complete: async (options: LLMRequestOptions): Promise<LLMResponse> => {
      const apiKey = process.env.ANTHROPIC_API_KEY
      if (!apiKey) {
        throw new Error('ANTHROPIC_API_KEY not set')
      }

      const messages = options.messages.map(m => ({
        role: m.role,
        content: typeof m.content === 'string' 
          ? m.content 
          : m.content.map(c => c.type === 'text' ? { type: 'text', text: c.text } : c),
      }))

      const body: Record<string, unknown> = {
        model: options.model,
        max_tokens: options.maxTokens || 1024,
        messages,
      }

      if (options.systemPrompt) {
        body.system = options.systemPrompt
      }

      if (options.temperature !== undefined) {
        body.temperature = options.temperature
      }

      const response = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': apiKey,
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify(body),
      })

      if (!response.ok) {
        const errorText = await response.text()
        throw new Error(`Anthropic API error: ${response.status} ${errorText}`)
      }

      const data = await response.json() as {
        content: Array<{ type: string; text?: string }>
        stop_reason: string
        usage: { input_tokens: number; output_tokens: number }
        model: string
      }

      return {
        content: data.content.map(c => ({
          type: c.type as 'text',
          text: c.text,
        })),
        stopReason: data.stop_reason,
        usage: {
          inputTokens: data.usage.input_tokens,
          outputTokens: data.usage.output_tokens,
        },
        model: data.model,
      }
    },

    stream: async function* (options: LLMRequestOptions) {
      // Side queries typically don't need streaming, but implement for interface compliance
      const response = await this.complete(options)
      yield {
        type: 'message_stop' as const,
        message: response,
      }
    },

    getErrorContext: () => 'Anthropic side query provider',
  }
}

// ============================================================================
// Exports
// ============================================================================

export { getOllamaProvider }
