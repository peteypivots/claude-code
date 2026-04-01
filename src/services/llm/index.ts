/**
 * LLM Provider Public API
 */

export { getGlobalLLMRouter, resetGlobalLLMRouter, type RouterConfig } from './router.js'
export { FallbackProvider, type FallbackConfig } from './providerFallback.js'
export { AnthropicProvider, type AnthropicProviderConfig } from './anthropicProvider.js'
export { OllamaProvider, type OllamaConfig } from './ollamaClient.ts'
export {
  type ILLMProvider,
  type LLMProvider,
  type LLMMessage,
  type LLMRequestOptions,
  type LLMResponse,
  type LLMStreamEvent,
  type MessageContent,
  ProviderError,
} from './types.js'

// Streaming adapter utilities
export {
  createStreamAdapter,
  convertLLMResponseToAnthropicMessage,
  generateMessageId,
  convertLLMEventToAnthropicEvent,
} from './streamAdapter.js'

// Provider configuration
export {
  getConfiguredLLMProvider,
  isOllamaEnabled,
  isAnthropicEnabled,
  getProviderConfigInfo,
  logProviderConfig,
  type LLMProviderName,
} from './providerConfig.js'

// QueryEngine integration
export {
  wrapProviderStreamForQueryModel,
  shouldUseProviderAbstraction,
  streamFromLLMProvider,
  completeFromLLMProvider,
  shouldFallbackToAnthropicForProvider,
  getQueryEngineProviderInfo,
} from './queryEngineIntegration.js'

// Tool calling support for Ollama
export {
  toolDefinitionsToPrompt,
  parseToolCalls,
  hasToolCalls,
  extractTextBeforeToolCalls,
  processToolResponse,
  prepareToolRequest,
  injectToolResults,
  type ToolDefinition,
  type ExtractedToolCall,
  type ToolCallResult,
} from './toolWrapper.js'

// Query Model Router (compound system)
export {
  queryModelWithRouting,
  shouldUseLocalModel,
  getRoutingDecisionAsync,
  getCostStats,
  resetCostStats,
  recordLocalCall,
  recordClaudeCall,
  clearRoutingCache,
  getCacheStats,
  defaultRouterConfig,
  type RouterConfig as QueryRouterConfig,
  type QueryModelParams,
} from './queryModelRouter.js'

// Side Query Provider (memory selection)
export {
  sideQuery,
  type SideQueryOptions,
  type SideQueryResult,
  type ProviderContext,
} from './sideQueryProvider.js'

// Orchestrator Model (routing decisions)
export {
  getRoutingDecision,
  clearRoutingCache as clearOrchestratorCache,
  getCacheStats as getOrchestratorCacheStats,
  isOrchestratorAvailable,
  type RoutingContext,
  ORCHESTRATOR_CONFIG,
} from './orchestratorModel.js'

// Routing Prompts
export {
  buildRoutingPrompt,
  buildFewShotExamples,
  parseRoutingResponse,
  ROUTING_SYSTEM_PROMPT,
  ROUTING_FEW_SHOT_EXAMPLES,
  type RoutingDecision,
} from './routingPrompt.js'

// Reasoning Provider (DeepSeek-R1)
export {
  reason,
  reasonStream,
  isReasoningAvailable,
  REASONING_CONFIG,
  type ReasoningRequest,
  type ReasoningResult,
  type ReasoningConfig,
} from './reasoningProvider.js'

// Model Pool (multi-model registry)
export {
  ModelPool,
  getModelPool,
  resetModelPool,
  getProviderForTier,
  getBestAvailableModel,
  type ModelTier,
  type ModelConfig,
  type PoolConfig,
} from './modelPool.js'

export {
  ToolEnabledOllamaProvider,
  createToolEnabledOllamaProvider,
} from './toolEnabledOllama.js'
