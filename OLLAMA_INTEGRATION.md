# Ollama Integration Guide

## Overview

Claude Code now supports **local-first LLM inference** using Ollama with automatic fallback to Anthropic API. This enables:

- **Privacy**: Keep conversations local by default (no data sent to Anthropic unless Ollama is unavailable)
- **Cost Reduction**: Use local models (qwen2.5:7b) first, fallback to paid Anthropic API only when necessary
- **Resilience**: Continues working even if one provider fails
- **Flexibility**: Easy switching between providers

## Architecture

### Provider Abstraction Layer

The implementation uses a clean provider abstraction that:

1. **ILLMProvider Interface** - Defines standard LLM provider contract
2. **AnthropicProvider** - Wraps existing Anthropic SDK
3. **OllamaProvider** - REST API client for Ollama
4. **FallbackProvider** - Orchestrates primary/secondary providers
5. **LLMRouter** - Global router managing all providers

### Directory Structure

```
src/services/llm/
├── index.ts                  # Public API exports
├── types.ts                  # Shared type definitions
├── router.ts                 # Global LLM router
├── anthropicProvider.ts      # Anthropic implementation
├── ollamaClient.ts          # Ollama implementation
└── providerFallback.ts      # Fallback orchestration
```

## Configuration

### Environment Variables

Add these to your `.env` file (see `.env` for defaults):

```bash
# ── Ollama Configuration ────────────────────────────
OLLAMA_BASE_URL=http://host.docker.internal:11434
OLLAMA_TIMEOUT=120000          # milliseconds
OLLAMA_RETRIES=3

# ── LLM Provider Selection ──────────────────────────
LLM_PRIMARY_PROVIDER=ollama     # or 'anthropic'
LLM_SECONDARY_PROVIDER=anthropic
LLM_ENABLE_FALLBACK=true
LLM_LOG_PROVIDER=false
```

### Docker Setup

The `docker-compose.yml` is pre-configured to:

- Use `host.docker.internal:11434` to reach Ollama on the host
- Pass all LLM environment variables to the container
- Enable fallback to Anthropic if Ollama is unavailable

### Model Selection

Currently configured for **qwen2.5:7b** (full-featured, fast):

```
OLLAMA_BASE_URL=http://host.docker.internal:11434
```

Other available models:
- `qwen2.5:3b-instruct` - Smaller, faster
- `dolphin-mistral` - Alternative
- `Qwen2-VL-2B` - Vision capabilities

## Usage

### Basic Usage (Automatic Provider Selection)

No code changes needed! The LLMRouter automatically:

1. Tries Ollama first (local)
2. Falls back to Anthropic if Ollama fails
3. Logs provider switching if `LLM_LOG_PROVIDER=true`

### Checking Provider Status

```typescript
import { getGlobalLLMRouter } from 'src/services/llm'

const router = getGlobalLLMRouter()

// Get current provider
console.log(router.getCurrentProvider())  // 'ollama' or 'anthropic'

// Check if using fallback
console.log(router.isUsingFallback())  // true if on secondary provider

// Get provider health status
const status = await router.getProviderStatus()
console.log(status)
// {
//   ollama: { available: true },
//   anthropic: { available: true }
// }
```

### Force Specific Provider (Testing)

```typescript
import { AnthropicProvider, OllamaProvider, FallbackProvider } from 'src/services/llm'

// Use only Anthropic
const anthropic = new AnthropicProvider()
await anthropic.complete(options)

// Use only Ollama
const ollama = new OllamaProvider()
await ollama.complete(options)
```

## Troubleshooting

### Ollama Not Available

**Symptoms**: Docker logs show "Switched to anthropic provider: Primary provider unavailable"

**Solutions**:

1. Verify Ollama is running on host:
   ```bash
   curl http://localhost:11434/api/tags
   ```

2. Check network from container:
   ```bash
   docker exec claude-code-instance curl http://host.docker.internal:11434/api/tags
   ```

3. Verify environment variable:
   ```bash
   docker exec claude-code-instance echo $OLLAMA_BASE_URL
   ```

### Ollama Timeouts

**Symptoms**: Requests timeout, then fallback to Anthropic

**Solutions**:

1. Increase timeout:
   ```bash
   # In .env
   OLLAMA_TIMEOUT=180000  # 3 minutes instead of 2 minutes
   ```

2. Check system resources:
   ```bash
   # GPU memory usage
   nvidia-smi
   
   # CPU/RAM usage
   docker stats ollama
   ```

3. Reduce parallel requests:
   ```bash
   # In ollama docker-compose.yml
   OLLAMA_NUM_PARALLEL=5  # was 10
   ```

### Provider Switching Delays

**Symptoms**: Fallback takes 30+ seconds to trigger

**Symptoms Fix**: The retry logic with exponential backoff is working. Consider:

1. Set shorter timeout for faster fallback:
   ```bash
   OLLAMA_TIMEOUT=30000  # 30 seconds
   ```

2. Reduce retry count:
   ```bash
   OLLAMA_RETRIES=1  # was 3
   ```

## Monitoring

### Enable Provider Logging

Set in `.env`:
```bash
LLM_LOG_PROVIDER=true
LOG_LEVEL=debug
```

Then monitor docker logs:
```bash
docker logs -f claude-code-instance | grep "LLMRouter\|Provider"
```

### Metrics to Track

1. **Primary Provider Success Rate**: Count successful Ollama requests
2. **Fallback Rate**: How often Anthropic is used vs Ollama
3. **Latency**: Response times per provider
4. **Cost**: API calls to Anthropic (fallback count × cost per token)

### Sample Logging Output

```
[LLMRouter] LLMRouter initialized: primary=ollama, secondary=anthropic, fallback=true
[LLMRouter.stream] model=qwen2.5:7b, provider=ollama
[Provider] Switched to anthropic provider: Primary provider unavailable
[LLMRouter.stream] model=claude-3-5-sonnet, provider=anthropic
```

## Performance Characteristics

### Ollama (qwen2.5:7b)

- **First Token**: 300-500ms (cold)
- **Throughput**: 50-80 tokens/second
- **Cost**: Free (local)
- **Privacy**: 100% (all local)
- **Latency**: <50ms network overhead

### Anthropic (Claude)

- **First Token**: 1-2 seconds (depends on quote time)
- **Throughput**: 100+ tokens/second
- **Cost**: $3/$15 per 1M input/output tokens
- **Privacy**: Sent to Anthropic servers
- **Latency**: Cloud roundtrip

### When to Use Primary vs Fallback

**Use Ollama (Primary)** for:
- Development & testing
- Long-form analysis (better throughput)
- Privacy-critical tasks
- Cost-sensitive workloads

**Fallback to Anthropic** for:
- Complex reasoning (Claude capabilities)
- Real-time interactive sessions
- When Ollama is unavailable
- Tool use requiring sophisticated logic

## Advanced Configuration

### Custom Provider Implementation

Add your own provider by implementing `ILLMProvider`:

```typescript
import { type ILLMProvider, type LLMRequestOptions, type LLMResponse } from 'src/services/llm'

class CustomProvider implements ILLMProvider {
  getName() { return 'custom' }
  async isAvailable() { /* ... */ }
  async complete(options: LLMRequestOptions): Promise<LLMResponse> { /* ... */ }
  async *stream(options) { /* ... */ }
  getErrorContext() { /* ... */ }
}

// Use with router
const router = new LLMRouter()
providers.set('custom', new CustomProvider())
```

### Non-Docker Setup

If running without Docker:

```bash
# .env for direct Ollama (no docker)
OLLAMA_BASE_URL=http://localhost:11434

# .env for direct Anthropic
ANTHROPIC_API_KEY=sk-ant-...
```

## Web Search Integration (SearXNG)

When running in local-first mode, Claude Code uses **SearXNG** for web search instead of external APIs.

### Configuration

Add to `docker-compose.yml` (already configured):

```yaml
services:
  searxng:
    image: searxng/searxng:latest
    ports:
      - "8888:8080"
    environment:
      - SEARXNG_BASE_URL=http://localhost:8888/

  claude-code:
    environment:
      - SEARXNG_URL=http://searxng:8080
```

### How It Works

1. `WebSearchTool` detects local-first mode via `OLLAMA_BASE_URL` env var
2. When triggered, calls SearXNG API instead of external search APIs
3. Results are formatted with "Key information found:" summary to help model answer
4. Search instruction says "IMPORTANT: Use the information above to answer the user's question"

### Files

- `src/tools/WebSearchTool/searxng.ts` - SearXNG REST client
- `src/tools/WebSearchTool/WebSearchTool.ts` - Tool implementation (checks for local mode)

### Testing

```bash
# Direct SearXNG test
curl "http://localhost:8888/search?q=capital+of+france&format=json"

# Through Claude Code
docker exec -i claude-code-instance sh -c 'echo "What is the capital of France?" | /root/claude-code'
```

## Tool Loop Detection & Force-Answer

Small local models sometimes get stuck calling the same tool repeatedly. The router detects and handles this.

### Detection Mechanism

Located in `src/services/llm/queryModelRouter.ts`:

```typescript
// Detects 3+ consecutive calls to the same tool
detectToolLoop(messages): { detected: boolean, toolName: string }
```

### Force-Answer Behavior

When a loop is detected AND web search results exist in the conversation:

1. After `MAX_BLOCKED_ATTEMPTS=1` blocked loop, forces a text response
2. Extracts key info from search results in message history
3. Returns formatted answer using the search snippets

### Fallback Text (Important!)

In `ollamaClient.ts`, when tool results return empty, the fallback text must NOT mention specific tools or resources that might confuse the model:

```typescript
// Good - generic guidance
"I should now answer the user's question based on the information I've already gathered..."

// Bad - mentions specific resource that model might try to access
"I should access MCP resources to find more information..."
```

## Integration Checklist

- [x] Provider abstraction layer created
- [x] Ollama REST client implemented
- [x] Anthropic adapter created
- [x] Fallback orchestration implemented
- [x] Global router with singleton pattern
- [x] Environment configuration
- [x] Docker Compose integration
- [x] Web search via SearXNG
- [x] Tool loop detection and handling
- [x] Force-answer with search results
- [ ] Health checks (Phase 5)
- [ ] E2E testing (Phase 6)

## Next Steps

### Phase 5: Health Checks & Monitoring

- Add health endpoint for SearXNG availability
- Add Prometheus metrics for routing decisions
- Track tool loop frequency

### Phase 6: Testing & Validation

- Unit tests for each provider
- Integration tests for web search flow
- Test force-answer behavior with various query types
- Integration tests for fallback scenarios
- Benchmark: qwen2.5:7b vs Claude
- Test with different models

## References

- [Ollama Documentation](https://github.com/ollama/ollama)
- [Ollama API Reference](https://github.com/ollama/ollama/blob/main/docs/api.md)
- [Anthropic SDK Docs](https://github.com/anthropics/anthropic-sdk-python)
- [Local LLM Best Practices](https://huggingface.co/docs/hub/index)
