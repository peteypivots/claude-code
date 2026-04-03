#!/bin/sh
# lancedb-nitter-check.sh — Dedup check for nitter data in LanceDB
#
# Usage:
#   lancedb-nitter-check.sh post <tweet_id>                    # check by tweet_id hash
#   lancedb-nitter-check.sh user <username>                    # check if user exists
#   lancedb-nitter-check.sh relationship <src> <tgt> <type>    # count relationship edges
#   lancedb-nitter-check.sh search <query_text> [threshold]    # vector similarity search on posts
#
# Environment:
#   LANCEDB_URI       — LanceDB REST API (default: http://lancedb-api:8000)
#   OLLAMA_BASE_URL   — Ollama for embeddings (default: http://ollama:11434)
#   EMBEDDING_MODEL   — embedding model (default: nomic-embed-text)

set -e

RECORD_TYPE="${1:?Usage: lancedb-nitter-check.sh <post|user|relationship|search> <args...>}"
shift

LANCEDB_URI="${LANCEDB_URI:-http://lancedb-api:8000}"
OLLAMA_BASE_URL="${OLLAMA_BASE_URL:-http://ollama:11434}"
EMBEDDING_MODEL="${EMBEDDING_MODEL:-nomic-embed-text}"
DB="user_dbs"

table_exists() {
  local table="$1"
  local list
  list=$(curl -sf "$LANCEDB_URI/dbs/$DB/tables" 2>/dev/null || echo '{"tables":[]}')
  echo "$list" | jq -r ".tables[]?.name | select(. == \"$table\")" 2>/dev/null
}

gen_embedding() {
  local text="$1"
  local escaped
  escaped=$(printf '%s' "$text" | sed 's/\\/\\\\/g; s/"/\\"/g' | tr '\n' ' ')
  curl -sf "$OLLAMA_BASE_URL/api/embed" \
    -H "Content-Type: application/json" \
    -d "{\"model\": \"$EMBEDDING_MODEL\", \"input\": \"$escaped\"}" 2>/dev/null \
    | jq '.embeddings[0] // empty' 2>/dev/null
}

# ── Check Post ─────────────────────────────────────────────
check_post() {
  local TWEET_ID="${1:?Usage: lancedb-nitter-check.sh post <tweet_id>}"
  local TABLE="nitter_posts"
  local BASE="$LANCEDB_URI/dbs/$DB/tables/$TABLE"

  local HAS_TABLE
  HAS_TABLE=$(table_exists "$TABLE")
  if [ -z "$HAS_TABLE" ]; then
    echo '{"exists": false, "reason": "table_not_found"}'
    return 0
  fi

  local CONTENT_HASH
  CONTENT_HASH=$(printf '%s' "$TWEET_ID" | sha256sum | cut -d' ' -f1)

  local RESULT
  RESULT=$(curl -sf "$BASE/query" \
    -H "Content-Type: application/json" \
    -d "{\"filter\": \"content_hash = '$CONTENT_HASH'\", \"limit\": 1}" 2>/dev/null || echo '{"records":[]}')

  local COUNT
  COUNT=$(echo "$RESULT" | jq '.records | length' 2>/dev/null || echo "0")
  if [ "$COUNT" -gt 0 ]; then
    local EXISTING
    EXISTING=$(echo "$RESULT" | jq '{exists: true, id: .records[0].id, username: .records[0].username, tweet_id: .records[0].tweet_id, content_hash: "'"$CONTENT_HASH"'"}')
    echo "$EXISTING"
  else
    echo "{\"exists\": false, \"content_hash\": \"$CONTENT_HASH\"}"
  fi
}

# ── Check User ─────────────────────────────────────────────
check_user() {
  local USERNAME="${1:?Usage: lancedb-nitter-check.sh user <username>}"
  local TABLE="nitter_users"
  local BASE="$LANCEDB_URI/dbs/$DB/tables/$TABLE"

  local HAS_TABLE
  HAS_TABLE=$(table_exists "$TABLE")
  if [ -z "$HAS_TABLE" ]; then
    echo '{"exists": false, "reason": "table_not_found"}'
    return 0
  fi

  local USERNAME_LOWER
  USERNAME_LOWER=$(printf '%s' "$USERNAME" | tr '[:upper:]' '[:lower:]')

  local RESULT
  RESULT=$(curl -sf "$BASE/query" \
    -H "Content-Type: application/json" \
    -d "{\"filter\": \"username = '$USERNAME_LOWER'\", \"limit\": 1}" 2>/dev/null || echo '{"records":[]}')

  local COUNT
  COUNT=$(echo "$RESULT" | jq '.records | length' 2>/dev/null || echo "0")
  if [ "$COUNT" -gt 0 ]; then
    echo "$RESULT" | jq '{exists: true, id: .records[0].id, username: .records[0].username, category: .records[0].category, crawl_priority: .records[0].crawl_priority, last_crawled: .records[0].last_crawled}'
  else
    echo "{\"exists\": false, \"username\": \"$USERNAME_LOWER\"}"
  fi
}

# ── Check Relationship ─────────────────────────────────────
check_relationship() {
  local SOURCE="${1:?Usage: lancedb-nitter-check.sh relationship <source> <target> <type>}"
  local TARGET="${2:?Missing target user}"
  local REL_TYPE="${3:?Missing relationship_type}"
  local TABLE="nitter_relationships"
  local BASE="$LANCEDB_URI/dbs/$DB/tables/$TABLE"

  local HAS_TABLE
  HAS_TABLE=$(table_exists "$TABLE")
  if [ -z "$HAS_TABLE" ]; then
    echo '{"exists": false, "weight": 0, "reason": "table_not_found"}'
    return 0
  fi

  local SRC_LOWER
  SRC_LOWER=$(printf '%s' "$SOURCE" | tr '[:upper:]' '[:lower:]')
  local TGT_LOWER
  TGT_LOWER=$(printf '%s' "$TARGET" | tr '[:upper:]' '[:lower:]')

  # Count records with this edge — weight = count
  local RESULT
  RESULT=$(curl -sf "$BASE/query" \
    -H "Content-Type: application/json" \
    -d "{\"filter\": \"source_user = '$SRC_LOWER' AND target_user = '$TGT_LOWER' AND relationship_type = '$REL_TYPE'\", \"limit\": 100}" 2>/dev/null || echo '{"records":[]}')

  local COUNT
  COUNT=$(echo "$RESULT" | jq '.records | length' 2>/dev/null || echo "0")
  if [ "$COUNT" -gt 0 ]; then
    local FIRST_SEEN
    FIRST_SEEN=$(echo "$RESULT" | jq -r '[.records[].first_seen] | sort | .[0]')
    local LAST_SEEN
    LAST_SEEN=$(echo "$RESULT" | jq -r '[.records[].last_seen] | sort | .[-1]')
    echo "{\"exists\": true, \"weight\": $COUNT, \"source_user\": \"$SRC_LOWER\", \"target_user\": \"$TGT_LOWER\", \"relationship_type\": \"$REL_TYPE\", \"first_seen\": \"$FIRST_SEEN\", \"last_seen\": \"$LAST_SEEN\"}"
  else
    echo "{\"exists\": false, \"weight\": 0, \"source_user\": \"$SRC_LOWER\", \"target_user\": \"$TGT_LOWER\", \"relationship_type\": \"$REL_TYPE\"}"
  fi
}

# ── Vector Search Posts ────────────────────────────────────
search_posts() {
  local QUERY="${1:?Usage: lancedb-nitter-check.sh search <query_text> [threshold]}"
  local THRESHOLD="${2:-0.5}"
  local TABLE="nitter_posts"
  local BASE="$LANCEDB_URI/dbs/$DB/tables/$TABLE"

  local HAS_TABLE
  HAS_TABLE=$(table_exists "$TABLE")
  if [ -z "$HAS_TABLE" ]; then
    echo '{"matches": [], "reason": "table_not_found"}'
    return 0
  fi

  local EMBEDDING
  EMBEDDING=$(gen_embedding "$QUERY")
  if [ -z "$EMBEDDING" ] || [ "$EMBEDDING" = "null" ]; then
    echo '{"matches": [], "error": "embedding_failed"}'
    return 0
  fi

  local RESULT
  RESULT=$(curl -sf "$BASE/search" \
    -H "Content-Type: application/json" \
    -d "{\"query_vector\": $EMBEDDING, \"limit\": 10}" 2>/dev/null || echo '{"results":[]}')

  # Filter by threshold and format
  echo "$RESULT" | jq --arg thresh "$THRESHOLD" '{
    matches: [.results[] | select((._distance // 1) < ($thresh | tonumber)) | {
      id: .id,
      tweet_id: .tweet_id,
      username: .username,
      text: .text,
      distance: ._distance
    }]
  }'
}

# ── Get Users by Crawl Priority ────────────────────────────
# Bonus: list users sorted by priority for the crawler
get_crawl_queue() {
  local LIMIT="${1:-20}"
  local TABLE="nitter_users"
  local BASE="$LANCEDB_URI/dbs/$DB/tables/$TABLE"

  local HAS_TABLE
  HAS_TABLE=$(table_exists "$TABLE")
  if [ -z "$HAS_TABLE" ]; then
    echo '{"users": [], "reason": "table_not_found"}'
    return 0
  fi

  # Get users, sorted by crawl_priority descending
  # LanceDB doesn't support ORDER BY, so we fetch all and sort in jq
  local RESULT
  RESULT=$(curl -sf "$BASE/query" \
    -H "Content-Type: application/json" \
    -d "{\"limit\": $LIMIT}" 2>/dev/null || echo '{"records":[]}')

  echo "$RESULT" | jq '{
    users: [.records | sort_by(-.crawl_priority) | .[] | {
      username: .username,
      category: .category,
      crawl_priority: .crawl_priority,
      last_crawled: .last_crawled,
      discovered_from: .discovered_from
    }]
  }'
}

# ── Dispatch ───────────────────────────────────────────────
case "$RECORD_TYPE" in
  post)           check_post "$@" ;;
  user)           check_user "$@" ;;
  relationship)   check_relationship "$@" ;;
  search)         search_posts "$@" ;;
  crawl-queue)    get_crawl_queue "$@" ;;
  *)
    echo "{\"error\": \"Unknown check type: $RECORD_TYPE. Use: post, user, relationship, search, crawl-queue\"}"
    exit 1
    ;;
esac
