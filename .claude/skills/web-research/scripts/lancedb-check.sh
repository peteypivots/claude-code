#!/bin/sh
# lancedb-check.sh — 3-layer dedup check against LanceDB
#
# Usage: lancedb-check.sh <query_text> [freshness_hours] [content_hash] [source_url]
#
# Environment:
#   LANCEDB_URI       — LanceDB REST API base URL (default: http://lancedb-api:8000)
#
# Output: JSON with matches, scores, and dedup_layer that triggered

set -e

QUERY_TEXT="${1:?Usage: lancedb-check.sh <query_text> [freshness_hours] [content_hash] [source_url]}"
FRESHNESS_HOURS="${2:-}"
CONTENT_HASH="${3:-}"
SOURCE_URL="${4:-}"

LANCEDB_URI="${LANCEDB_URI:-http://lancedb-api:8000}"
DB="user_dbs"
TABLE="research_findings"
BASE="$LANCEDB_URI/dbs/$DB/tables/$TABLE"

# Check if table exists by listing tables in the database
TABLE_LIST=$(curl -sf "$LANCEDB_URI/dbs/$DB/tables" 2>/dev/null || echo '{"tables":[]}')
HAS_TABLE=$(echo "$TABLE_LIST" | jq -r ".tables[]?.name | select(. == \"$TABLE\")" 2>/dev/null)
if [ -z "$HAS_TABLE" ]; then
  echo '{"dedup_layer": "none", "matches": [], "expanded_window": false, "note": "table does not exist yet"}'
  exit 0
fi

# ── Layer 1: Content Hash (O(1), cheapest) ─────────────────
if [ -n "$CONTENT_HASH" ]; then
  HASH_RESULT=$(curl -sf "$BASE/query" \
    -H "Content-Type: application/json" \
    -d "{\"filter\": \"content_hash = '$CONTENT_HASH'\", \"limit\": 1}" 2>/dev/null || echo '{"records":[]}')

  HASH_COUNT=$(echo "$HASH_RESULT" | jq '.records | length' 2>/dev/null || echo "0")
  if [ "$HASH_COUNT" -gt 0 ]; then
    echo "$HASH_RESULT" | jq '{dedup_layer: "content_hash", matches: .records, expanded_window: false}'
    exit 0
  fi
fi

# ── Layer 2: URL Match (O(1)) ──────────────────────────────
if [ -n "$SOURCE_URL" ]; then
  ESCAPED_URL=$(echo "$SOURCE_URL" | sed "s/'/''/g")
  URL_RESULT=$(curl -sf "$BASE/query" \
    -H "Content-Type: application/json" \
    -d "{\"filter\": \"source_url = '$ESCAPED_URL'\", \"limit\": 1}" 2>/dev/null || echo '{"records":[]}')

  URL_COUNT=$(echo "$URL_RESULT" | jq '.records | length' 2>/dev/null || echo "0")
  if [ "$URL_COUNT" -gt 0 ]; then
    echo "$URL_RESULT" | jq '{dedup_layer: "source_url", matches: .records, expanded_window: false}'
    exit 0
  fi
fi

# ── Layer 3: Semantic Vector Search (expensive) ────────────
# LanceDB's internal embed service is misconfigured, so we embed via Ollama directly
# and use query_vector instead of query_text

OLLAMA_BASE_URL="${OLLAMA_BASE_URL:-http://ollama:11434}"
EMBEDDING_MODEL="${EMBEDDING_MODEL:-nomic-embed-text}"

# Escape and embed query text via Ollama
ESCAPED_QUERY=$(printf '%s' "$QUERY_TEXT" | sed 's/\\/\\\\/g; s/"/\\"/g' | tr '\n' ' ')
EMBED_RESPONSE=$(curl -sf "$OLLAMA_BASE_URL/api/embed" \
  -H "Content-Type: application/json" \
  -d "{\"model\": \"$EMBEDDING_MODEL\", \"input\": \"$ESCAPED_QUERY\"}" 2>/dev/null)

QUERY_VECTOR=$(echo "$EMBED_RESPONSE" | jq '.embeddings[0] // empty' 2>/dev/null)

# Build freshness filter
FILTER=""
if [ -n "$FRESHNESS_HOURS" ]; then
  CUTOFF=$(date -u -d "-${FRESHNESS_HOURS} hours" +%Y-%m-%dT%H:%M:%SZ 2>/dev/null || \
           date -u -v-"${FRESHNESS_HOURS}"H +%Y-%m-%dT%H:%M:%SZ 2>/dev/null || echo "")
  if [ -n "$CUTOFF" ]; then
    FILTER="\"filter\": \"timestamp > '$CUTOFF'\","
  fi
fi

VECTOR_RESULT='{"results":[]}'
VECTOR_COUNT=0

if [ -n "$QUERY_VECTOR" ] && [ "$QUERY_VECTOR" != "null" ]; then
  # Vector search via query_vector (pre-embedded)
  # NOTE: search endpoint returns .results, query endpoint returns .records
  VECTOR_RESULT=$(curl -sf "$BASE/search" \
    -H "Content-Type: application/json" \
    -d "{\"query_vector\": $QUERY_VECTOR, $FILTER \"top_k\": 5}" 2>/dev/null || echo '{"results":[]}')

  VECTOR_COUNT=$(echo "$VECTOR_RESULT" | jq '.results | length' 2>/dev/null || echo "0")
fi

# If freshness filter returned 0 results, try fallback (7-day window)
EXPANDED_WINDOW="false"
if [ "$VECTOR_COUNT" -eq 0 ] && [ -n "$FRESHNESS_HOURS" ] && [ -n "$QUERY_VECTOR" ] && [ "$QUERY_VECTOR" != "null" ]; then
  FALLBACK_HOURS=168  # 7 days
  FALLBACK_CUTOFF=$(date -u -d "-${FALLBACK_HOURS} hours" +%Y-%m-%dT%H:%M:%SZ 2>/dev/null || \
                    date -u -v-"${FALLBACK_HOURS}"H +%Y-%m-%dT%H:%M:%SZ 2>/dev/null || echo "")
  if [ -n "$FALLBACK_CUTOFF" ]; then
    VECTOR_RESULT=$(curl -sf "$BASE/search" \
      -H "Content-Type: application/json" \
      -d "{\"query_vector\": $QUERY_VECTOR, \"filter\": \"timestamp > '$FALLBACK_CUTOFF'\", \"top_k\": 5}" 2>/dev/null || echo '{"results":[]}')

    VECTOR_COUNT=$(echo "$VECTOR_RESULT" | jq '.results | length' 2>/dev/null || echo "0")
    if [ "$VECTOR_COUNT" -gt 0 ]; then
      EXPANDED_WINDOW="true"
    fi
  fi
fi

# Also check canonical_query match (hybrid retrieval)
ESCAPED_CANONICAL=$(printf '%s' "$QUERY_TEXT" | tr '[:upper:]' '[:lower:]' | sed "s/'/''/g")
CANONICAL_RESULT=$(curl -sf "$BASE/query" \
  -H "Content-Type: application/json" \
  -d "{\"filter\": \"canonical_query = '$ESCAPED_CANONICAL'\", \"limit\": 5}" 2>/dev/null || echo '{"records":[]}')

# Merge results (vector uses .results, canonical uses .records)
MERGED=$(echo "{\"vector\": $VECTOR_RESULT, \"canonical\": $CANONICAL_RESULT}" | \
  jq '[.vector.results // [], .canonical.records // []] | add | unique_by(.id) // []')

echo "{\"dedup_layer\": \"semantic\", \"matches\": $MERGED, \"expanded_window\": $EXPANDED_WINDOW}"
