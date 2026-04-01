/**
 * LLM Provider Configuration
 * 
 * Determines which LLM provider (Ollama, Anthropic, etc.) to use based on
 * environment variables and configuration settings.
 * 
 * Priority:
 * 1. CLAUDE_LLM_PROVIDER environment variable
 * 2. Fallback to 'anthropic' for backwards compatibility
 */

export type LLMProviderName = 'ollama' | 'anthropic' | 'auto';

/**
 * Gets the configured LLM provider from environment
 * 
 * Environment Variables:
 * - CLAUDE_LLM_PROVIDER: Explicitly set provider ('ollama', 'anthropic', 'auto')
 * - OLLAMA_BASE_URL: If set, defaults to 'ollama' provider
 * - ANTHROPIC_API_KEY: Standard Anthropic configuration
 * 
 * Returns:
 * - 'ollama': Use local Ollama (primary)
 * - 'anthropic': Use Anthropic API (fallback)
 * - 'auto': Use primary if available, fallback to secondary (default)
 */
export function getConfiguredLLMProvider(): LLMProviderName {
  const explicit = process.env.CLAUDE_LLM_PROVIDER?.toLowerCase();
  if (explicit === 'ollama' || explicit === 'anthropic') {
    return explicit;
  }

  // Auto-detect based on available configuration
  if (explicit === 'auto' || !explicit) {
    // If Ollama is explicitly configured, prefer it
    if (process.env.OLLAMA_BASE_URL) {
      return 'ollama';
    }
    
    // Otherwise use Anthropic (existing behavior)
    return 'anthropic';
  }

  // Invalid value, fall back to anthropic
  return 'anthropic';
}

/**
 * Checks if Ollama provider is configured and should be used
 */
export function isOllamaEnabled(): boolean {
  const provider = getConfiguredLLMProvider();
  return provider === 'ollama';
}

/**
 * Checks if Anthropic provider should be used
 */
export function isAnthropicEnabled(): boolean {
  const provider = getConfiguredLLMProvider();
  return provider === 'anthropic';
}

/**
 * Gets information about the current provider configuration
 */
export function getProviderConfigInfo() {
  const provider = getConfiguredLLMProvider();
  const ollamaUrl = process.env.OLLAMA_BASE_URL || 'http://localhost:11434';
  const anthropicKey = process.env.ANTHROPIC_API_KEY ? '***' : 'not configured';
  
  return {
    provider,
    ollama: {
      enabled: provider === 'ollama',
      baseUrl: ollamaUrl,
    },
    anthropic: {
      enabled: provider === 'anthropic',
      apiKeyConfigured: !!process.env.ANTHROPIC_API_KEY,
    },
  };
}

/**
 * Logging helper for provider configuration
 */
export function logProviderConfig(): void {
  const config = getProviderConfigInfo();
  console.log('[LLMProvider] Configuration:');
  console.log(`  Provider: ${config.provider}`);
  console.log(`  Ollama: enabled=${config.ollama.enabled}, baseUrl=${config.ollama.baseUrl}`);
  console.log(`  Anthropic: enabled=${config.anthropic.enabled}, configured=${config.anthropic.apiKeyConfigured}`);
}
