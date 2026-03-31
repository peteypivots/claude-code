# ─────────────────────────────────────────────────────────────
# Claude Code CLI — Development Container
# ─────────────────────────────────────────────────────────────
# This image provides a ready-to-explore environment for the
# leaked source. It does NOT produce a runnable build (the
# original build tooling was not included in the leak).
# ─────────────────────────────────────────────────────────────

FROM oven/bun:1-alpine AS base

WORKDIR /app

# Install OS-level dependencies used at runtime
RUN apk add --no-cache git ripgrep

# Copy manifests first for layer caching
COPY package.json bun.lockb* ./

# Install npm packages
RUN bun install --frozen-lockfile || bun install

# Copy source
COPY . .

# Typecheck (optional — fails loudly if deps are wrong)
# RUN bun run typecheck

# Default: drop into a shell for exploration
CMD ["sh"]

