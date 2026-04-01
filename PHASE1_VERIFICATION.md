# Phase 1: Ollama Integration - Verification Guide

## Implementation Complete ✅

All Phase 1 (Provider Abstraction Layer) implementation is complete. This document guides you through verification and next steps.

## What Was Implemented

### 1. Provider Abstraction Layer (src/services/llm/)

**Core Files Created:**
- `types.ts` - Shared types for all providers (ILLMProvider interface, message types, errors)
- `router.ts` - Global LLM router managing provider selection and fallback
- `anthropicProvider.ts` - Anthropic SDK wrapper implementing ILLMProvider
- `ollamaClient.ts` - Ollama REST API client implementing ILLMProvider
- `providerFallback.ts` - FallbackProvider orchestrating primary/secondary fallback
- `health.ts` - Provider health monitoring and status tracking
- `testUtils.ts` - Testing utilities for provider validation
- `index.ts` - Public API exports

**Total Size:** ~60 KB of code

### 2. Configuration Updates

**Files Modified:**
- `docker-compose.yml` - Added Ollama environment variables and networking configuration
- `.env` - Added Ollama configuration with defaults
- `OLLAMA_INTEGRATION.md` - Comprehensive integration documentation

**Default Configuration:**
```
LLM_PRIMARY_PROVIDER=ollama
LLM_SECONDARY_PROVIDER=anthropic
LLM_ENABLE_FALLBACK=true
OLLAMA_BASE_URL=http://host.docker.internal:11434
OLLAMA_TIMEOUT=120000 ms
OLLAMA_RETRIES=3
```

### 3. Architecture Diagram

```
┌─────────────────────────────────────────────────────────┐
│                  Application Code                        │
│                  (QueryEngine.ts, etc)                   │
└──────────────────┬──────────────────────────────────────┘
                   │
                   ▼
┌──────────────────────────────────────────────────────────┐
│              Global LLM Router                            │
│         (getGlobalLLMRouter() Singleton)                 │
└──────────────────┬──────────────────────────────────────┘
                   │
        ┌──────────┴──────────┐
        ▼                     ▼
┌───────────────┐      ┌──────────────────┐
│FallbackRouter │  ◄──►│ Health Monitor   │
│(Primary/Sec) │      │(Track uptime)    │
└───────────────┘      └──────────────────┘
   │          │
   ▼          ▼
┌──────────────────────────────────────┐
│      Provider Pool (Pluggable)       │
├──────────────────────────────────────┤
│ ✓ OllamaProvider (REST API)         │
│ ✓ AnthropicProvider (SDK Wrapper)   │
│ □ Custom Providers (extensible)     │
└──────────────────────────────────────┘
   │              │
   ▼              ▼
[Ollama]      [Anthropic API]
Local LLM     Cloud Fallback
```

## Installation/Integration Steps

### Step 1: Rebuild Docker Image

The new TypeScript files need to be included in the Docker build:

```bash
cd /home/ables/gitroot/claude-code-full

# Rebuild the Docker image to include new provider files
docker build -t claude-code:latest -f Dockerfile .

# Verify build succeeded
docker images | grep claude-code
```

### Step 2: Update Docker Compose

The `docker-compose.yml` is already updated. Verify it has Ollama env vars:

```bash
# Check for Ollama configuration
grep -A 5 "LLM_PRIMARY_PROVIDER" docker-compose.yml
```

Should show:
```yaml
LLM_PRIMARY_PROVIDER: ${LLM_PRIMARY_PROVIDER:-ollama}
LLM_SECONDARY_PROVIDER: ${LLM_SECONDARY_PROVIDER:-anthropic}
```

### Step 3: Verify .env Configuration

Check `.env` has Ollama settings:

```bash
grep OLLAMA .env | head -10
```

Should show:
```
OLLAMA_BASE_URL=http://host.docker.internal:11434
OLLAMA_TIMEOUT=120000
OLLAMA_RETRIES=3
LLM_PRIMARY_PROVIDER=ollama
```

### Step 4: Start Docker Container

```bash
cd /home/ables/gitroot/claude-code-full

# Start both claude-code and promtail containers
docker-compose up -d

# Watch startup logs
docker-compose logs -f claude-code-instance
```

**Expected Log Output:**
```
[LLMRouter] LLMRouter initialized: primary=ollama, secondary=anthropic, fallback=true
```

### Step 5: Verify Provider Availability

Check if the provider system initializes correctly:

```bash
# Test from inside container
docker exec claude-code-instance curl http://host.docker.internal:11434/api/tags

# Should return list of available Ollama models
# If this fails, Ollama isn't accessible
```

## Testing

### Option A: Manual Testing (Docker)

```bash
# Access container shell
docker exec -it claude-code-instance sh

# Inside container, test Ollama connectivity
curl http://host.docker.internal:11434/api/tags

# Should show:
# {
#   "models": [
#     {"name": "qwen2.5:7b", ...},
#     ...
#   ]
# }
```

### Option B: Automated Testing (CLI)

```bash
cd /home/ables/gitroot/claude-code-full

# Run provider test utility (once QueryEngine integration is done)
node test-providers.mjs --verbose

# Expected output:
# 🧪 LLM Provider Test Suite
# 
# 📊 Phase 1: Provider Availability Check
# ✓ ollama       3ms
# ✓ anthropic    125ms
# 
# 📝 Phase 2: Basic Completion Test
# ✓ Ollama: 1250ms
# ...
```

### Option C: Manual Docker Compose Test

```bash
# Stop existing container
docker stop claude-code-instance

# Start with docker-compose (cleaner startup)
docker-compose down
docker-compose up -d

# Tail the logs
docker-compose logs -f claude-code-instance

# Should see provider initialization
```

## Troubleshooting

### Issue: Ollama Not Reachable from Container

**Symptoms:**
- Docker logs show "Switched to anthropic provider: Primary provider unavailable"
- `docker exec ... curl http://host.docker.internal:11434/api/tags` fails

**Solution:**

1. Verify Ollama is running on host:
   ```bash
   ps aux | grep ollama
   curl http://localhost:11434/api/tags
   ```

2. Check Docker's host.docker.internal resolution:
   ```bash
   docker exec claude-code-instance ping host.docker.internal
   ```

3. Update `.env` if Ollama is on different host:
   ```bash
   OLLAMA_BASE_URL=http://YOUR_HOST_IP:11434
   ```

### Issue: Timeouts

**Symptoms:**
- Requests timeout, then fallback to Anthropic after 120 seconds

**Solution:**

1. Check Ollama is running:
   ```bash
   docker stats ollama
   ```

2. Reduce timeout in `.env`:
   ```bash
   OLLAMA_TIMEOUT=30000  # 30 seconds instead of 2 minutes
   ```

3. Check system resources:
   ```bash
   nvidia-smi  # GPU memory
   docker stats  # CPU/RAM
   ```

## Phase 2-6 Road map

Once Phase 1 verification is complete:

### Phase 2: QueryEngine Integration
- Modify `src/QueryEngine.ts` to use `getGlobalLLMRouter()`
- Update `src/query.ts` to route through provider system
- Modify `src/services/api/withRetry.ts` to integrate with router

### Phase 3: Docker Integration
- Add health checks to docker-compose.yml
- Link Ollama services (already on same host network)
- Test fallback scenarios

### Phase 4: Logging & Visibility
- Add provider-aware logging to QueryEngine
- Create status commands for CLI
- Track usage metrics per provider

### Phase 5: Testing & Validation
- Unit tests for each provider
- Integration tests for fallback behavior
- Performance benchmarking
- Edge case testing (network failures, timeouts)

## Architecture Highlights

### 1. Zero Breaking Changes
- Existing code continues to work as-is
- Provider system is additive
- Can be integrated gradually into QueryEngine

### 2. Clean Separation of Concerns
- ILLMProvider interface doesn't know about HTTP/REST
- Providers don't know about routing/fallback logic
- Health monitoring is independent

### 3. Extensibility
- Add new providers by implementing ILLMProvider
- Custom message converters per provider
- Pluggable health check strategies

### 4. Resilience
- Automatic fallback on provider failure
- Health monitoring with consecutive failure tracking
- Exponential backoff on retries

### 5. Observability
- Per-provider latency metrics
- Uptime tracking
- Optional debug logging
- Health status snapshots

## Performance Profile

### Ollama (qwen2.5:7b)
- **Latency:** 300-500ms first token, then 50-80 tokens/sec
- **Memory:** ~5GB GPU (already loaded)
- **Cost:** $0 (local)
- **Privacy:** 100%

### Anthropic (Fallback)
- **Latency:** 1-2s first token, then 100+ tokens/sec
- **Memory:** None (cloud)
- **Cost:** $3/$15 per 1M input/output tokens
- **Privacy:** Sent to Anthropic

## Configuration Options

### Enable Fallback (Default: true)
```bash
LLM_ENABLE_FALLBACK=true  # Try secondary if primary fails
LLM_ENABLE_FALLBACK=false # Fail if primary is unavailable
```

### Logging (Default: false)
```bash
LLM_LOG_PROVIDER=true   # Log provider switches and health checks
LLM_LOG_PROVIDER=false  # Silent operation
```

### Timeouts (Default: 120s)
```bash
OLLAMA_TIMEOUT=30000   # Fail faster (30 seconds)
OLLAMA_TIMEOUT=300000  # More patient (5 minutes)
```

### Model Selection
```bash
# Ollama model (set when using router in code)
# Options: qwen2.5:7b, qwen2.5:3b-instruct, dolphin-mistral

# Anthropic model (set when using router in code)
# Current standard: claude-3-5-sonnet-20241022
```

## Files Summary

| File | Lines | Purpose |
|------|-------|---------|
| types.ts | 85 | Core interfaces and types |
| router.ts | 120 | Global router and singleton |
| anthropicProvider.ts | 150 | Anthropic SDK wrapper |
| ollamaClient.ts | 250 | Ollama REST API client |
| providerFallback.ts | 180 | Fallback orchestration |
| health.ts | 240 | Health monitoring |
| testUtils.ts | 350 | Test utilities |
| **Total** | **~1,375** | **Documentation + utilities** |

## Next Steps

1. **Verify Phase 1 Works**
   - [ ] Docker container builds without errors
   - [ ] Verify environment variables are set
   - [ ] Check Ollama connectivity from container
   - [ ] (Optional) Run test-providers.mjs

2. **Plan Phase 2: QueryEngine Integration**
   - Identify where QueryEngine makes API calls
   - Determine message format conversion needed
   - Plan integration approach

3. **Schedule Phase 3-5 Implementation**
   - Docker integration
   - Logging/visibility
   - Testing/benchmarking

## Reference Documentation

- [OLLAMA_INTEGRATION.md](./OLLAMA_INTEGRATION.md) - Comprehensive integration guide
- [src/services/llm/index.ts](./src/services/llm/index.ts) - Public API
- [docker-compose.yml](./docker-compose.yml) - Container configuration
- [.env](./.env) - Environment configuration

## Support

For issues during verification:

1. Check Docker logs:
   ```bash
   docker-compose logs -f claude-code-instance
   ```

2. Verify Ollama accessibility:
   ```bash
   curl http://localhost:11434/api/tags
   ```

3. Check configuration:
   ```bash
   docker exec claude-code-instance env | grep LLM_
   ```

4. Test provider directly:
   ```bash
   docker exec claude-code-instance sh
   # Inside container:
   curl http://host.docker.internal:11434/api/tags
   ```
