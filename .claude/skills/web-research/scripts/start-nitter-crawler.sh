#!/bin/sh
set -eu

DELAY="${1:-120}"
LOG_DIR="${NITTER_CRAWLER_LOG_DIR:-/data/logs}"
LOG_FILE="$LOG_DIR/nitter-crawler.log"
mkdir -p "$LOG_DIR"

cd /app/mcp-server/src
exec bun run /app/mcp-server/src/run-crawler.mjs --delay "$DELAY" 2>&1 | tee -a "$LOG_FILE" /proc/1/fd/1 >/dev/null
