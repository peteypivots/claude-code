# ─────────────────────────────────────────────────────────────
# Claude Code CLI — Production Container
# ─────────────────────────────────────────────────────────────
# Multi-stage build: builds a production bundle, then copies
# only the output into a minimal runtime image.
#
# Usage:
#   docker build -t claude-code .
#   docker run --rm -e ANTHROPIC_API_KEY=sk-... claude-code -p "hello"
# ─────────────────────────────────────────────────────────────

# Stage 1: Build
FROM oven/bun:1-alpine AS builder

WORKDIR /app

# Copy manifests first for layer caching
COPY package.json bun.lockb* ./

# Install all dependencies (including devDependencies for build)
RUN bun install --frozen-lockfile || bun install

# Copy source
COPY . .

# Build production bundle
RUN bun run build:prod

# Stage 2: Runtime
FROM oven/bun:1-alpine

WORKDIR /app

# Install OS-level runtime dependencies
RUN apk add --no-cache git ripgrep curl jq bash python3

# Install os-eco tools globally (canopy, mulch, seeds, overstory)
# These power the hook system for prompt management and expertise tracking
RUN bun add -g @os-eco/canopy-cli @os-eco/mulch-cli @os-eco/seeds-cli @os-eco/overstory-cli 2>/dev/null || true

# Copy package.json for external dependencies
COPY --from=builder /app/package.json /app/package.json

# Install only the external runtime deps that couldn't be bundled
RUN bun add fflate turndown --no-save 2>/dev/null || true

# Copy only the bundled output from the builder
COPY --from=builder /app/dist/cli.mjs /app/cli.mjs

# Copy MCP server source and build it
COPY --from=builder /app/mcp-server /app/mcp-server
COPY --from=builder /app/src /app/src
RUN cd /app/mcp-server && bun install && bun run build

# Make it executable
RUN chmod +x /app/cli.mjs

# Add launcher scripts (PATH + home directory)
# --dangerously-skip-permissions bypasses all permission prompts for headless/automated use
RUN printf '#!/bin/sh\nexec bun /app/cli.mjs --dangerously-skip-permissions "$@"\n' > /usr/local/bin/claude-code \
    && chmod +x /usr/local/bin/claude-code \
    && cp /usr/local/bin/claude-code /root/claude-code

# Bake project-level MCP config into /app/.mcp.json
RUN printf '{\n  "mcpServers": {\n    "claude-code-explorer": {\n      "type": "stdio",\n      "command": "node",\n      "args": ["/app/mcp-server/dist/src/index.js"],\n      "env": {\n        "CLAUDE_CODE_SRC_ROOT": "/app/src"\n      }\n    }\n  }\n}\n' > /app/.mcp.json

# Project instructions (injected into system prompt)
COPY CLAUDE.md /app/CLAUDE.md

RUN mkdir -p /root/.claude

# Keep container alive; exec into it and run ./claude-code
CMD ["tail", "-f", "/dev/null"]


