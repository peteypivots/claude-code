/**
 * Query Engine LLM Provider Integration
 * 
 * Bridges the existing queryModel function with the provider abstraction layer.
 * This module handles routing between Claude's existing Anthropic integration
 * and the new provider abstraction, allowing seamless switching between Ollama and Anthropic.
 */

import type { BetaRawMessageStreamEvent, BetaMessageStreamParams } from '@anthropic-ai/sdk/resources/beta/messages'
import { 
  getGlobalLLMRouter,
  type LLMRequestOptions,
} from './index'
import { createStreamAdapter, generateMessageId } from './streamAdapter'
import { isOllamaEnabled } from './providerConfig'

/**
 * Helper to convert system parameter from Anthropic format to string
 */
function convertSystemForProvider(system: string | any[] | undefined): string | undefined {
  if (!system) return undefined
  if (typeof system === 'string') return system
  // If array, convert to string (join text blocks)
  if (Array.isArray(system)) {
    return system
      .map((block: any) => (typeof block === 'string' ? block : block.text || ''))
      .join('\n')
  }
  return undefined
}

/**
 * Stream wrapper for provider-agnostic requests
 * 
 * Converts an LLM provider stream to Anthropic SDK event format for use
 * in the existing queryModel function. This allows Ollama and other providers
 * to be used with minimal changes to the existing streaming logic.
 * 
 * Usage:
 * ```typescript
 * const messageId = generateMessageId();
 * const requestOptions = convertBetaParamsToRequestOptions(params, messages);
 * const provider = getGlobalLLMRouter();
 * const eventStream = wrapProviderStreamForQueryModel(
 *   provider.stream(requestOptions),
 *   messageId
 * );
 * // Now eventStream yields BetaRawMessageStreamEvent
 * ```
 */
export async function* wrapProviderStreamForQueryModel(
  providerStream: AsyncGenerator<any, void, unknown>,
  messageId: string = generateMessageId(),
): AsyncGenerator<BetaRawMessageStreamEvent, void, unknown> {
  // Use the stream adapter to convert provider events to Anthropic format
  yield* createStreamAdapter(providerStream, messageId);
}

/**
 * Determines if a request should use the provider abstraction instead of direct Anthropic
 * 
 * Returns true if:
 * - Ollama is explicitly enabled via CLAUDE_LLM_PROVIDER or OLLAMA_BASE_URL
 * - The provider abstraction is available and functional
 * 
 * NOTE: When LOCAL_FIRST or OLLAMA_BASE_URL is set, the main query path uses
 * queryModelWithRouting (via deps.callModel) which handles local routing properly.
 * This function is called by queryModelWithStreaming for OTHER callers (like
 * WebSearchTool's Anthropic fallback). To avoid duplicate Ollama requests,
 * we now return false when local-first routing is active - those other paths
 * should either use SearXNG (WebSearchTool) or fall through to Anthropic.
 */
export async function shouldUseProviderAbstraction(): Promise<boolean> {
  // DISABLED: When local-first routing is active via queryModelWithRouting,
  // this path creates duplicate Ollama requests. The main query loop already
  // routes to Ollama via handleLocalAction(). Other callers (like WebSearchTool)
  // should use their own local backends (SearXNG) or fall through to Anthropic.
  // 
  // To re-enable this path for non-main-loop callers, we'd need to coordinate
  // with queryModelWithRouting to avoid the double-call issue.
  if (process.env.OLLAMA_BASE_URL || process.env.LOCAL_FIRST === 'true') {
    return false;
  }

  if (!isOllamaEnabled()) {
    return false;
  }

  // Check if the provider is actually available
  const router = getGlobalLLMRouter();
  const available = await router.isAvailable();
  
  if (!available) {
    console.warn('[QueryEngine] Ollama configured but not available, falling back to Anthropic');
    return false;
  }

  return true;
}

/**
 * Gateway function for streaming queries using the provider abstraction
 * 
 * This is called from withinthe queryModel function's withRetry handler to stream
 * responses from the configured LLM provider.
 * 
 * Parameters match the structure of BetaMessageStreamParams so integration is minimal.
 */
export async function* streamFromLLMProvider(
  params: BetaMessageStreamParams,
  messageId?: string,
): AsyncGenerator<BetaRawMessageStreamEvent, void, unknown> {
  const router = getGlobalLLMRouter()
  
  // Convert BetaMessageStreamParams to LLMRequestOptions
  // Extract essential fields needed by the provider
  const requestOptions: LLMRequestOptions = {
    model: params.model as string,
    messages: (params.messages || []) as any[],
    maxTokens: params.max_tokens,
    systemPrompt: convertSystemForProvider(params.system),
    temperature: (params as any).temperature,
    // Pass tools through so Ollama can use native function calling
    tools: (params as any).tools as LLMRequestOptions['tools'],
  }
  
  // Stream from the provider
  const providerStream = router.stream(requestOptions)
  
  // Wrap for Anthropic SDK compatibility
  yield* createStreamAdapter(providerStream, messageId || generateMessageId())
}

/**
 * Complete request (non-streaming) using the provider abstraction
 * 
 * Used for non-streaming requests to fetch a complete response from the LLM provider.
 */
export async function completeFromLLMProvider(
  params: BetaMessageStreamParams,
): Promise<any> {
  const router = getGlobalLLMRouter()
  
  // Convert BetaMessageStreamParams to LLMRequestOptions
  const requestOptions: LLMRequestOptions = {
    model: params.model as string,
    messages: (params.messages || []) as any[],
    maxTokens: params.max_tokens,
    systemPrompt: convertSystemForProvider(params.system),
    temperature: (params as any).temperature,
    tools: (params as any).tools as LLMRequestOptions['tools'],
  }
  
  // Get complete response from provider
  const response = await router.complete(requestOptions)
  
  // Return as simple message object compatible with Anthropic format
  return {
    id: generateMessageId(),
    type: 'message',
    role: 'assistant',
    content: response.content.map((c: any) => ({
      type: 'text',
      text: c.text || '',
    })),
    model: response.model,
    stop_reason: response.stopReason || 'end_turn',
    stop_sequence: null,
    usage: {
      input_tokens: 0,
      output_tokens: 0,
    },
  }
}

/**
 * Checks provider health and falls back if needed
 * 
 * This is called before attempting a request to ensure the provider is available.
 * If Ollama is unavailable, it returns true to indicate Anthropic should be used as fallback.
 */
export async function shouldFallbackToAnthropicForProvider(): Promise<boolean> {
  if (!isOllamaEnabled()) {
    return false; // Already using Anthropic, no fallback needed
  }

  // Don't fallback to Anthropic if the key is invalid/placeholder
  const apiKey = process.env.ANTHROPIC_API_KEY
  if (!apiKey || apiKey.includes('YOUR_API_KEY')) {
    return false;
  }

  const router = getGlobalLLMRouter();
  const available = await router.isAvailable();
  
  if (!available) {
    console.warn('[QueryEngine] Ollama unavailable, using Anthropic fallback');
    return true;
  }

  return false;
}

/**
 * Provider information for logging and debugging
 */
export function getQueryEngineProviderInfo() {
  const router = getGlobalLLMRouter();
  const currentProvider = router.getName();
  
  return {
    currentProvider,
    isOllamaEnabled: isOllamaEnabled(),
    healthStatus: null, // Would be populated from router.getProviderStatus()
  };
}
