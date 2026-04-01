# Running Claude Code Interactively in Docker

## Current Status
- **Bundled build (`cli.mjs`)**: React 19 hook initialization issue — `useEffectEvent is not a function`
- **Source build**: Works fine with `bun src/entrypoints/cli.tsx`

## Quick Start (Works Now)

### Option 1: One-off Command
```bash
docker run -it --rm \
  -e ANTHROPIC_API_KEY=sk-ant-YOUR_KEY_HERE \
  -e OLLAMA_BASE_URL=http://ollama:11434 \
  -e LOG_LEVEL=info \
  -v ~/.ssh:/root/.ssh:ro \
  -v $(pwd):/workspace \
  --network ollama_default \
  -w /app \
  oven/bun:1-alpine \
  sh -c "cd /home/ables/gitroot/claude-code-full && bun install --frozen-lockfile && bun src/entrypoints/cli.tsx 'help'"
```

### Option 2: Interactive Shell
```bash
# Start container
docker run -it --rm \
  -e ANTHROPIC_API_KEY=sk-ant-YOUR_KEY_HERE \
  -e OLLAMA_BASE_URL=http://ollama:11434 \
  --network ollama_default \
  -w /home/ables/gitroot/claude-code-full \
  oven/bun:1-alpine \
  /bin/sh

# Inside container:
bun install --frozen-lockfile
bun src/entrypoints/cli.tsx "what is 2+2?"
bun src/entrypoints/cli.tsx "analyze /workspace/myfile.ts"
```

### Option 3: Keep Container Running
```bash
# Start container in background
docker run -d \
  -e ANTHROPIC_API_KEY=sk-ant-YOUR_KEY_HERE \
  -e OLLAMA_BASE_URL=http://ollama:11434 \
  --network ollama_default \
  -w /home/ables/gitroot/claude-code-full \
  --name claude-work \
  oven/bun:1-alpine \
  sleep infinity

# Then exec commands into it
docker exec -it claude-work bun src/entrypoints/cli.tsx "your prompt here"

# Cleanup
docker stop claude-work
docker rm claude-work
```

## Fixing the Build

The bundled version has a React 19 hook initialization issue. To fix:

1. **Check if react is externalized** in `scripts/build-bundle.ts`
   - Look fo the `external: [...]` array
   - Remove or comment out `'react'`

2. **Rebuild**:
   ```bash
   docker build -t claude-code:latest .
   ```

3. **Then the old way works**:
   ```bash
   docker run -it claude-code:latest bun /app/cli.mjs "your prompt"
   ```

## Environment Variables

- `ANTHROPIC_API_KEY` — Required, get from console.anthropic.com
- `OLLAMA_BASE_URL` — Default: `http://ollama:11434`
- `LOG_LEVEL` — Options: `debug`, `info`, `warn`, `error`

## Volume Mounts

```bash
-v ~/.ssh:/root/.ssh:ro          # SSH keys for git
-v ~/.gitconfig:/root/.gitconfig:ro  # Git config
-v $(pwd):/workspace             # Current directory
```

## Network

Use `--network ollama_default` to connect to Ollama service running on host.
