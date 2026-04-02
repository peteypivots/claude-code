#!/bin/sh
# lancedb-store.sh — Store a research finding in LanceDB with dedup guard
#
# Usage: echo '<json_finding>' | lancedb-store.sh
#   OR:  lancedb-store.sh < finding.json
#
# The JSON input should be a structured finding with fields:
#   query, canonical_query, source_url, domain, title, summary,
#   key_points, entities, tags, timestamp, source_rank, source_tier
#
# The script will:
#   1. Generate content_hash from title + source_url + timestamp
#   2. Check for hash duplicates
#   3. Check for URL duplicates
#   4. Generate embedding via Ollama
#   5. Normalize entities
#   6. Generate UUID
#   7. Insert into LanceDB
#
# Environment:
#   LANCEDB_URI       — LanceDB REST API base URL (default: http://lancedb-api:8000)
#
# Output: JSON with stored status, id, and content_hash — or DUPLICATE reason

set -e

LANCEDB_URI="${LANCEDB_URI:-http://lancedb-api:8000}"
DB="user_dbs"
TABLE="research_findings"
BASE="$LANCEDB_URI/dbs/$DB/tables/$TABLE"

# Read JSON from stdin
INPUT=$(cat)

if [ -z "$INPUT" ]; then
  echo '{"error": "No JSON input provided"}'
  exit 1
fi

# Extract fields
TITLE=$(echo "$INPUT" | jq -r '.title // ""')
SOURCE_URL=$(echo "$INPUT" | jq -r '.source_url // ""')
TIMESTAMP=$(echo "$INPUT" | jq -r '.timestamp // ""')
SUMMARY=$(echo "$INPUT" | jq -r '.summary // ""')

if [ -z "$TITLE" ] || [ -z "$SOURCE_URL" ]; then
  echo '{"error": "Missing required fields: title, source_url"}'
  exit 1
fi

# ── Generate Content Hash ──────────────────────────────────
TITLE_LOWER=$(printf '%s' "$TITLE" | tr '[:upper:]' '[:lower:]')
if [ -n "$TIMESTAMP" ]; then
  HASH_INPUT="${TITLE_LOWER}${SOURCE_URL}${TIMESTAMP}"
else
  SUMMARY_PREFIX=$(printf '%.200s' "$SUMMARY")
  HASH_INPUT="${TITLE_LOWER}${SOURCE_URL}${SUMMARY_PREFIX}"
fi
CONTENT_HASH=$(printf '%s' "$HASH_INPUT" | sha256sum | cut -d' ' -f1)

# Check if table exists yet
TABLE_LIST=$(curl -sf "$LANCEDB_URI/dbs/$DB/tables" 2>/dev/null || echo '{"tables":[]}')
HAS_TABLE=$(echo "$TABLE_LIST" | jq -r ".tables[]?.name | select(. == \"$TABLE\")" 2>/dev/null)

if [ -n "$HAS_TABLE" ]; then
  # ── Layer 1: Hash Dedup ────────────────────────────────────
  HASH_RESULT=$(curl -sf "$BASE/query" \
    -H "Content-Type: application/json" \
    -d "{\"filter\": \"content_hash = '$CONTENT_HASH'\", \"limit\": 1}" 2>/dev/null || echo '{"records":[]}')

  HASH_COUNT=$(echo "$HASH_RESULT" | jq '.records | length' 2>/dev/null || echo "0")
  if [ "$HASH_COUNT" -gt 0 ]; then
    EXISTING_ID=$(echo "$HASH_RESULT" | jq -r '.records[0].id // "unknown"')
    echo "{\"stored\": false, \"reason\": \"DUPLICATE: content_hash match\", \"existing_id\": \"$EXISTING_ID\", \"content_hash\": \"$CONTENT_HASH\"}"
    exit 0
  fi

  # ── Layer 2: URL Dedup ─────────────────────────────────────
  ESCAPED_URL=$(echo "$SOURCE_URL" | sed "s/'/''/g")
  URL_RESULT=$(curl -sf "$BASE/query" \
    -H "Content-Type: application/json" \
    -d "{\"filter\": \"source_url = '$ESCAPED_URL'\", \"limit\": 1}" 2>/dev/null || echo '{"records":[]}')

  URL_COUNT=$(echo "$URL_RESULT" | jq '.records | length' 2>/dev/null || echo "0")
  if [ "$URL_COUNT" -gt 0 ]; then
    EXISTING_ID=$(echo "$URL_RESULT" | jq -r '.records[0].id // "unknown"')
    echo "{\"stored\": false, \"reason\": \"DUPLICATE: source_url match\", \"existing_id\": \"$EXISTING_ID\", \"content_hash\": \"$CONTENT_HASH\"}"
    exit 0
  fi
fi

# ── Generate Embedding via Ollama ───────────────────────────
OLLAMA_BASE_URL="${OLLAMA_BASE_URL:-http://ollama:11434}"
EMBEDDING_MODEL="${EMBEDDING_MODEL:-nomic-embed-text}"
ESCAPED_SUMMARY=$(printf '%s' "$SUMMARY" | sed 's/\\/\\\\/g; s/"/\\"/g' | tr '\n' ' ')
EMBED_RESPONSE=$(curl -sf "$OLLAMA_BASE_URL/api/embed" \
  -H "Content-Type: application/json" \
  -d "{\"model\": \"$EMBEDDING_MODEL\", \"input\": \"$ESCAPED_SUMMARY\"}" 2>/dev/null)

if [ -z "$EMBED_RESPONSE" ]; then
  echo '{"error": "Failed to generate embedding from Ollama"}'
  exit 1
fi

EMBEDDING=$(echo "$EMBED_RESPONSE" | jq '.embeddings[0] // empty' 2>/dev/null)

if [ -z "$EMBEDDING" ] || [ "$EMBEDDING" = "null" ]; then
  # Fallback: store without embedding vector
  EMBEDDING="null"
fi

# ── Normalize Entities ─────────────────────────────────────
ENTITIES=$(echo "$INPUT" | jq '[.entities[]? | ascii_downcase | ltrimstr(" ") | rtrimstr(" ") |
  if . == "open ai" or . == "open-ai" then "openai"
  elif . == "gpt 5" or . == "gpt5" then "gpt-5"
  elif . == "google deepmind" or . == "google deep mind" then "deepmind"
  elif . == "microsoft corp" or . == "microsoft corporation" then "microsoft"
  elif . == "meta platforms" or . == "facebook" then "meta"
  elif . == "nvidia corp" or . == "nvidia corporation" then "nvidia"
  elif . == "anthropic ai" then "anthropic"
  else . end] | unique')

# ── Generate UUID ──────────────────────────────────────────
if [ -f /proc/sys/kernel/random/uuid ]; then
  UUID=$(cat /proc/sys/kernel/random/uuid)
else
  UUID=$(od -x /dev/urandom | head -1 | awk '{print $2$3"-"$4"-"$5"-"$6"-"$7$8$9}')
fi

# ── Build Record ───────────────────────────────────────────
if [ "$EMBEDDING" != "null" ]; then
  RECORD=$(echo "$INPUT" | jq \
    --arg id "$UUID" \
    --arg content_hash "$CONTENT_HASH" \
    --argjson entities "$ENTITIES" \
    --argjson embedding "$EMBEDDING" \
    '. + {
      id: $id,
      content_hash: $content_hash,
      entities: $entities,
      embedding: $embedding
    }')
else
  RECORD=$(echo "$INPUT" | jq \
    --arg id "$UUID" \
    --arg content_hash "$CONTENT_HASH" \
    --argjson entities "$ENTITIES" \
    '. + {
      id: $id,
      content_hash: $content_hash,
      entities: $entities
    }')
fi

# ── Insert into LanceDB ───────────────────────────────────
INSERT_RESPONSE=$(curl -sf -w '\n%{http_code}' "$BASE/ingest" \
  -H "Content-Type: application/json" \
  -d "{\"records\": [$RECORD]}" 2>/dev/null)

HTTP_CODE=$(echo "$INSERT_RESPONSE" | tail -1)
BODY=$(echo "$INSERT_RESPONSE" | sed '$d')

if [ "$HTTP_CODE" = "200" ] || [ "$HTTP_CODE" = "201" ]; then
  echo "{\"stored\": true, \"id\": \"$UUID\", \"content_hash\": \"$CONTENT_HASH\"}"
else
  echo "{\"stored\": false, \"error\": \"LanceDB insert failed (HTTP $HTTP_CODE)\", \"detail\": $(echo "$BODY" | jq '.' 2>/dev/null || echo "\"$BODY\""), \"content_hash\": \"$CONTENT_HASH\"}"
  exit 1
fi
