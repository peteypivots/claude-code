#!/bin/bash
# nitter-mcp-client.sh — Thin wrapper to call nitter-mcp tools via JSON-RPC over HTTP
#
# Usage:
#   nitter-mcp-client.sh search "bitcoin" [limit]
#   nitter-mcp-client.sh user "elonmusk" [limit]
#   nitter-mcp-client.sh advanced '{"from_user":"elonmusk","min_likes":100}' [limit]
#   nitter-mcp-client.sh hashtag "bitcoin" [limit]
#   nitter-mcp-client.sh health
#
# Output: JSONL — one JSON object per tweet matching lancedb-nitter-store.sh schema:
#   {tweet_id, username, text, pub_date, permalink, mentions[], hashtags[],
#    quoted_user, reply_to_user, source_query}
#
# For "health": JSON health status object
#
# Environment:
#   NITTER_MCP_URL  — nitter-mcp HTTP endpoint (default: http://localhost:8085)

set -euo pipefail

MODE="${1:?Usage: nitter-mcp-client.sh <search|user|advanced|hashtag|health> <query> [limit]}"
QUERY="${2:-}"
LIMIT="${3:-20}"

NITTER_MCP_URL="${NITTER_MCP_URL:-http://172.23.0.1:8085}"
# Host header override — nitter-mcp rejects non-localhost Host headers (421)
MCP_HOST_HEADER="${MCP_HOST_HEADER:-localhost:8085}"

# ── MCP Session Management ────────────────────────────────
# Initialize a session, call a tool, return structured content.
# Each invocation creates a fresh session (stateless for simplicity).

mcp_call() {
  local tool_name="$1"
  local tool_args="$2"

  # Step 1: Initialize
  local init_resp
  init_resp=$(curl -s -D /tmp/nitter-mcp-headers.$$ -X POST "$NITTER_MCP_URL/" \
    -H "Host: $MCP_HOST_HEADER" \
    -H "Content-Type: application/json" \
    -H "Accept: application/json, text/event-stream" \
    -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-03-26","capabilities":{},"clientInfo":{"name":"nitter-crawler","version":"1.0"}}}' \
    2>/dev/null) || {
    echo '{"error":"MCP init failed"}' >&2
    return 1
  }

  local session_id
  session_id=$(grep -i 'mcp-session-id' /tmp/nitter-mcp-headers.$$ 2>/dev/null | tr -d '\r' | awk '{print $2}')
  rm -f /tmp/nitter-mcp-headers.$$

  if [ -z "$session_id" ]; then
    echo '{"error":"No MCP session ID"}' >&2
    return 1
  fi

  # Step 2: Send initialized notification
  curl -s -X POST "$NITTER_MCP_URL/" \
    -H "Host: $MCP_HOST_HEADER" \
    -H "Content-Type: application/json" \
    -H "Accept: application/json, text/event-stream" \
    -H "Mcp-Session-Id: $session_id" \
    -d '{"jsonrpc":"2.0","method":"notifications/initialized"}' \
    > /dev/null 2>&1

  # Step 3: Call tool
  local resp
  resp=$(curl -s -X POST "$NITTER_MCP_URL/" \
    -H "Host: $MCP_HOST_HEADER" \
    -H "Content-Type: application/json" \
    -H "Accept: application/json, text/event-stream" \
    -H "Mcp-Session-Id: $session_id" \
    -d "{\"jsonrpc\":\"2.0\",\"id\":2,\"method\":\"tools/call\",\"params\":{\"name\":\"$tool_name\",\"arguments\":$tool_args}}" \
    2>/dev/null)

  # Step 4: Parse SSE response — extract the last data: line with id:2
  echo "$resp" | grep '^data: ' | tail -1 | sed 's/^data: //' | jq -c '.result.structuredContent // .result.content[0].text' 2>/dev/null
}

# ── Extract mentions and hashtags from text ───────────────
# MCP returns clean text; extract @mentions and #hashtags with grep
enrich_tweet() {
  local tweet_json="$1"
  local source="$2"

  local text
  text=$(echo "$tweet_json" | jq -r '.description // .text // ""')

  # Extract @mentions (excluding the tweet creator)
  local creator
  creator=$(echo "$tweet_json" | jq -r '.creator // ""' | sed 's/^@//')
  local mentions_raw
  mentions_raw=$(echo "$text" | grep -oP '@[A-Za-z0-9_]+' 2>/dev/null | sed 's/^@//' | grep -v "^${creator}$" | sort -u || true)
  local mentions="[]"
  if [ -n "$mentions_raw" ]; then
    mentions=$(echo "$mentions_raw" | jq -R . | jq -sc .)
  fi

  # Extract #hashtags (min 2 chars to avoid URL anchors like #m)
  local hashtags_raw
  hashtags_raw=$(echo "$text" | grep -oP '#[A-Za-z0-9_]{2,}' 2>/dev/null | sed 's/^#//' | sort -u || true)
  local hashtags="[]"
  if [ -n "$hashtags_raw" ]; then
    hashtags=$(echo "$hashtags_raw" | jq -R . | jq -sc .)
  fi

  # Detect reply (text starts with "R to @user:")
  local reply_to=""
  reply_to=$(echo "$text" | grep -oP '^R to @\K[A-Za-z0-9_]+' 2>/dev/null || true)

  # Map MCP fields → store schema
  local username
  username=$(echo "$tweet_json" | jq -r '.creator // ""' | sed 's/^@//')
  local tweet_id
  tweet_id=$(echo "$tweet_json" | jq -r '.tweet_id // .guid // ""')
  local pub_date
  pub_date=$(echo "$tweet_json" | jq -r '.pubDate // ""')
  local permalink
  permalink=$(echo "$tweet_json" | jq -r '.link // ""')
  local clean_text
  clean_text=$(echo "$tweet_json" | jq -r '.description // .title // ""')

  jq -n -c \
    --arg tweet_id "$tweet_id" \
    --arg username "$username" \
    --arg text "$clean_text" \
    --arg pub_date "$pub_date" \
    --arg permalink "$permalink" \
    --argjson mentions "$mentions" \
    --argjson hashtags "$hashtags" \
    --arg reply_to_user "$reply_to" \
    --arg source_query "$source" \
    '{
      tweet_id: $tweet_id,
      username: $username,
      text: $text,
      pub_date: $pub_date,
      permalink: $permalink,
      mentions: $mentions,
      hashtags: $hashtags,
      quoted_user: "",
      reply_to_user: $reply_to_user,
      source_query: $source_query
    }'
}

# ── Commands ──────────────────────────────────────────────

case "$MODE" in
  health)
    mcp_call "nitter_health" '{}'
    ;;

  search)
    [ -z "$QUERY" ] && { echo "Missing query" >&2; exit 1; }
    local_query=$(printf '%s' "$QUERY" | jq -sR .)
    raw=$(mcp_call "nitter_search_tweets" "{\"query\":$local_query,\"limit\":$LIMIT}")

    # If raw is a string (quoted JSON), parse it; if object, use directly
    tweets=$(echo "$raw" | jq -c 'if type == "string" then fromjson else . end | .tweets[]?' 2>/dev/null)

    if [ -n "$tweets" ]; then
      echo "$tweets" | while IFS= read -r tweet; do
        enrich_tweet "$tweet" "$QUERY"
      done
    fi
    ;;

  user)
    [ -z "$QUERY" ] && { echo "Missing username" >&2; exit 1; }
    local_user=$(printf '%s' "$QUERY" | sed 's/^@//' | jq -sR .)
    # Profile pages broken on Nitter — use advanced search with from_user
    raw=$(mcp_call "nitter_advanced_search" "{\"from_user\":$local_user,\"limit\":$LIMIT}")

    tweets=$(echo "$raw" | jq -c 'if type == "string" then fromjson else . end | .tweets[]?' 2>/dev/null)

    if [ -n "$tweets" ]; then
      echo "$tweets" | while IFS= read -r tweet; do
        enrich_tweet "$tweet" "from:$QUERY"
      done
    fi
    ;;

  advanced)
    [ -z "$QUERY" ] && { echo "Missing JSON args" >&2; exit 1; }
    # QUERY is raw JSON args for nitter_advanced_search
    args=$(echo "$QUERY" | jq -c ". + {\"limit\": $LIMIT}" 2>/dev/null || echo "$QUERY")
    raw=$(mcp_call "nitter_advanced_search" "$args")

    local source_label
    source_label=$(echo "$QUERY" | jq -r 'to_entries | map(.key + ":" + (.value|tostring)) | join(",")' 2>/dev/null || echo "advanced")

    tweets=$(echo "$raw" | jq -c 'if type == "string" then fromjson else . end | .tweets[]?' 2>/dev/null)

    if [ -n "$tweets" ]; then
      echo "$tweets" | while IFS= read -r tweet; do
        enrich_tweet "$tweet" "$source_label"
      done
    fi
    ;;

  hashtag)
    [ -z "$QUERY" ] && { echo "Missing hashtag" >&2; exit 1; }
    local_tag=$(printf '%s' "$QUERY" | sed 's/^#//' | jq -sR .)
    raw=$(mcp_call "nitter_hashtag" "{\"hashtag\":$local_tag,\"limit\":$LIMIT}")

    tweets=$(echo "$raw" | jq -c 'if type == "string" then fromjson else . end | .tweets[]?' 2>/dev/null)

    if [ -n "$tweets" ]; then
      echo "$tweets" | while IFS= read -r tweet; do
        enrich_tweet "$tweet" "#$QUERY"
      done
    fi
    ;;

  *)
    echo "Unknown mode: $MODE" >&2
    echo "Usage: nitter-mcp-client.sh <search|user|advanced|hashtag|health> <query> [limit]" >&2
    exit 1
    ;;
esac
