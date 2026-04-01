# Phase 2: QueryEngine Integration Guide

**Status:** Implementation ready
**Scope:** Integrating LLM Provider Abstraction into `queryModel()` function
**Duration:** ~45 minutes of code modifications + testing

## Overview

This guide provides step-by-step instructions for integrating the LLM Provider abstraction layer into Claude Code's `queryModel()` function. The integration enables Ollama (local-first) with automatic fallback to Anthropic, with minimal changes to existing code.

### Key Benefits
- ✅ Local-first inference with Ollama (qwen2.5:7b)
- ✅ Automatic fallback to Anthropic on unavailability
- ✅ Transparent message format conversion
- ✅ Backward compatible (defaults to Anthropic)
- ✅ Environment-driven configuration

## Architecture

### Current Flow (Anthropic-Only)
```
queryModel()
  → withRetry()
    → getAnthropicClient()
    → anthropic.beta.messages.create()
    → return stream
  → consume stream
  → yield formatted messages
```

### New Flow (Provider-Agnostic)
```
queryModel()
  → Check: shouldUseProviderAbstraction?
    ├─ YES (Ollama enabled)
    │  → streamFromLLMProvider() [LLMRouter]
    │  → createStreamAdapter() [Anthropic format]
    │  → return BetaRawMessageStreamEvent stream
    └─ NO (Anthropic)
       → anthropic.beta.messages.create() [existing]
       → return stream
  → consume stream (unchanged)
  → yield formatted messages (unchanged)
```

## Code Modifications

### Step 1: Add Imports

**File:** `src/services/api/claude.ts` (Top-level imports section)

```typescript
// Add these imports alongside existing service imports
import {
  shouldUseProviderAbstraction,
  streamFromLLMProvider,
  shouldFallbackToAnthropicForProvider,
  getQueryEngineProviderInfo,
} from '../llm/queryEngineIntegration.js'
```

**Location:** Near other service imports (e.g., alongside `import * as anthropic from ...`)

### Step 2: Modify withRetry Handler

**File:** `src/services/api/claude.ts`  
**Function:** `queryModel()` → withRetry handler (approximately line 1766-1837)

**Current Code (lines 1797-1837):**
```typescript
  try {
    queryCheckpoint('query_client_creation_start')
    const generator = withRetry(
      () =>
        getAnthropicClient({
          maxRetries: 0,
          model: options.model,
          fetchOverride: options.fetchOverride,
          source: options.querySource,
        }),
      async (anthropic, attempt, context) => {
        attemptNumber = attempt
        isFastModeRequest = context.fastMode ?? false
        start = Date.now()
        attemptStartTimes.push(start)
        queryCheckpoint('query_client_creation_end')

        const params = paramsFromContext(context)
        captureAPIRequest(params, options.querySource)

        maxOutputTokens = params.max_tokens
        queryCheckpoint('query_api_request_sent')
        if (!options.agentId) {
          headlessProfilerCheckpoint('api_request_sent')
        }

        clientRequestId =
          getAPIProvider() === 'firstParty' && isFirstPartyAnthropicBaseUrl()
            ? randomUUID()
            : undefined

        // ↓ API CALL SITE - This is where we need to inject provider logic
        const result = await anthropic.beta.messages
          .create(
            { ...params, stream: true },
            {
              signal,
              ...(clientRequestId && {
                headers: { [CLIENT_REQUEST_ID_HEADER]: clientRequestId },
              }),
            },
          )
          .withResponse()
        queryCheckpoint('query_response_headers_received')
        streamRequestId = result.request_id
        streamResponse = result.response
        return result.data
      },
      // ... withRetry context
    )
```

**Modified Code (insert provider check before anthropic call):**

```typescript
  try {
    queryCheckpoint('query_client_creation_start')
    const generator = withRetry(
      () =>
        getAnthropicClient({
          maxRetries: 0,
          model: options.model,
          fetchOverride: options.fetchOverride,
          source: options.querySource,
        }),
      async (anthropic, attempt, context) => {
        attemptNumber = attempt
        isFastModeRequest = context.fastMode ?? false
        start = Date.now()
        attemptStartTimes.push(start)
        queryCheckpoint('query_client_creation_end')

        const params = paramsFromContext(context)
        captureAPIRequest(params, options.querySource)

        maxOutputTokens = params.max_tokens
        queryCheckpoint('query_api_request_sent')
        if (!options.agentId) {
          headlessProfilerCheckpoint('api_request_sent')
        }

        clientRequestId =
          getAPIProvider() === 'firstParty' && isFirstPartyAnthropicBaseUrl()
            ? randomUUID()
            : undefined

        // ↓ NEW: Check if we should use provider abstraction
        const useProviderAbstraction = await shouldUseProviderAbstraction()
        
        if (useProviderAbstraction) {
          try {
            // Route through LLM provider abstraction (Ollama)
            console.log('[QueryEngine] Using provider abstraction (Ollama)')
            const providerStream = streamFromLLMProvider(params)
            queryCheckpoint('query_response_headers_received')
            // For provider requests, we generate request ID on client side
            streamRequestId = `provider-${randomUUID()}`
            streamResponse = undefined
            return await providerStream
          } catch (providerError) {
            // If provider fails, check if we should fallback
            const shouldFallback = await shouldFallbackToAnthropicForProvider()
            if (shouldFallback) {
              console.warn('[QueryEngine] Provider failed, falling back to Anthropic:', providerError)
              // Continue to Anthropic path below
            } else {
              throw providerError
            }
          }
        }

        // EXISTING CODE: Anthropic path (either primary or fallback)
        const result = await anthropic.beta.messages
          .create(
            { ...params, stream: true },
            {
              signal,
              ...(clientRequestId && {
                headers: { [CLIENT_REQUEST_ID_HEADER]: clientRequestId },
              }),
            },
          )
          .withResponse()
        queryCheckpoint('query_response_headers_received')
        streamRequestId = result.request_id
        streamResponse = result.response
        return result.data
      },
      // ... withRetry context (unchanged)
    )
```

### Step 3: Update Stream Consumption (Optional)

**File:** `src/services/api/claude.ts`  
**Location:** After stream is obtained (line ~1854-1858)

**Current Code:**
```typescript
    let e
    do {
      e = await generator.next()

      // yield API error messages (the stream has a 'controller' property, error messages don't)
      if (!('controller' in e.value)) {
        yield e.value
      }
    } while (!e.done)
    stream = e.value as Stream<BetaRawMessageStreamEvent>
```

**No Changes Needed Here**

The stream consumption logic remains unchanged because:
- Both Anthropic and Ollama (via streamAdapter) return `BetaRawMessageStreamEvent`
- The `withResponse()` wrapper is Anthropic-specific but we handle that in the routing logic
- Error messages are typed the same way

### Step 4: Optional - Add Debug Logging

**Location:** In `queryModel()` function, after the try block starts

```typescript
  // Optional: Log provider configuration on first query
  if (process.env.DEBUG_CLAUDE_PROVIDER) {
    const providerInfo = getQueryEngineProviderInfo()
    console.log('[QueryEngine] Provider info:', providerInfo)
  }
```

## Environment Configuration

### Enable Ollama Provider
```bash
export CLAUDE_LLM_PROVIDER=ollama
export OLLAMA_BASE_URL=http://ollama:11434  # or IP:port
export OLLAMA_TIMEOUT=30000  # optional, ms
export OLLAMA_RETRIES=3     # optional
```

### Enable Debug Logging
```bash
export DEBUG_CLAUDE_PROVIDER=true
```

### Use Auto-Select (Ollama if available, else Anthropic)
```bash
export OLLAMA_BASE_URL=http://ollama:11434
# CLAUDE_LLM_PROVIDER not set (defaults to 'auto')
```

### Force Anthropic (Default)
```bash
export CLAUDE_LLM_PROVIDER=anthropic
# or unset everything
```

## Testing Plan

### Phase 2.1: Basic Integration Test
1. **Start services:**
   ```bash
   docker-compose up -d  # Ollama and claude-code
   ```

2. **Set environment:**
   ```bash
   export CLAUDE_LLM_PROVIDER=ollama
   export OLLAMA_BASE_URL=http://localhost:11434
   ```

3. **Run simple query:**
   ```typescript
   // In REPL or agent
   const result = await queryModel(
     [{role: 'user', content: [{ type: 'text', text: 'Say hello!' }]}],
     systemPrompt,
     thinkingConfig,
     tools,
     signal,
     options
   )
   ```

4. **Expected behavior:**
   - Logs show: "Using provider abstraction (Ollama)"
   - Response comes from Ollama (qwen2.5:7b)
   - Streaming works normally

### Phase 2.2: Fallback Test
1. **Stop Ollama:**
   ```bash
   docker-compose down ollama
   ```

2. **Run query (Ollama still enabled):**
   ```typescript
   const result = await queryModel(...)
   ```

3. **Expected behavior:**
   - Initial attempt fails with warning
   - Automatically falls back to Anthropic
   - Logs show: "Provider failed, falling back to Anthropic"
   - Response comes from Anthropic

### Phase 2.3: Streaming Test
1. **Enable Ollama:**
   ```bash
   docker-compose up -d ollama
   ```

2. **Stream query:**
   ```typescript
   for await (const event of queryModel(...)) {
     if (event.type === 'content_block_delta') {
       process.stdout.write(event.delta.text)
     }
   }
   ```

3. **Expected behavior:**
   - Tokens stream in real-time
   - Events match Anthropic format
   - No gaps or duplicates in content

### Phase 2.4: Message Format Test
1. **Run complex query:**
   ```typescript
   const result = await queryModel(
     messages,
     systemPrompt,
     thinkingConfig,
     tools, // With tool_use definitions
     signal,
     options
   )
   ```

2. **Verify:**
   - Message ID is valid (msg_xxxxxxxxx format)
   - Stop reason is correct
   - Token usage is accurate
   - Content blocks are properly formatted

## Rollback Plan

If integration causes issues, revert with:

```bash
# 1. Revert claude.ts changes (git)
git checkout src/services/api/claude.ts

# 2. Or disable provider abstraction via environment
unset CLAUDE_LLM_PROVIDER
export CLAUDE_LLM_PROVIDER=anthropic
```

The change is fully backward compatible - Anthropic remains the default.

## Verification Checklist

- [ ] Imports added to claude.ts
- [ ] Provider check added before Anthropic API call
- [ ] Fallback logic handles provider failures
- [ ] Environment variables are set correctly
- [ ] Service logs show provider being used
- [ ] Streaming works identically for both providers
- [ ] Message content is preserved through conversion
- [ ] Error handling works correctly

## Common Issues & Solutions

### Issue 1: "Ollama configured but not available"
**Cause:** `OLLAMA_BASE_URL` set but service not running
**Solution:** Start Ollama or set `CLAUDE_LLM_PROVIDER=anthropic`

### Issue 2: Stream hangs or times out
**Cause:** Ollama taking too long on complex queries
**Solution:** Increase `OLLAMA_TIMEOUT` or use simpler prompts

### Issue 3: Message format errors
**Cause:** Stream conversion missed edge case
**Solution:** Enable debug logs and check streamAdapter output

### Issue 4: Tool use not working
**Cause:** Ollama qwen2.5 doesn't support native tool_use
**Solution:** Use text-based tool descriptions (Phase 3 feature)

## Next Steps After Integration

1. **Phase 2.2:** Create comprehensive test suite
2. **Phase 2.3:** Add health checks and monitoring
3. **Phase 3:** Implement tool calling wrapper for Ollama
4. **Phase 3.1:** Optimize token streaming performance
5. **Phase 4:** Add caching and prompt optimization

## References

- **src/services/llm/types.ts** - ILLMProvider interface definition
- **src/services/llm/queryEngineIntegration.ts** - Integration gateway functions
- **src/services/llm/streamAdapter.ts** - Stream format conversion
- **src/services/api/messageConverter.ts** - Message format bridge
- **OLLAMA_INTEGRATION.md** - Configuration details
