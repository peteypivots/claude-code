#!/bin/sh
# lancedb-nitter-store.sh — Store nitter data in LanceDB (posts, users, relationships)
#
# Usage:
#   echo '<json>' | lancedb-nitter-store.sh post          # store a post
#   echo '<json>' | lancedb-nitter-store.sh user          # store/update a user
#   echo '<json>' | lancedb-nitter-store.sh relationship  # store/update a relationship
#
# Post JSON: {tweet_id, username, text, pub_date, permalink, mentions[], hashtags[],
#             quoted_user, reply_to_user, media_urls[], source_query}
# User JSON: {username, display_name, bio, category, discovered_from, discovery_method, crawl_priority, tags[]}
# Relationship JSON: {source_user, target_user, relationship_type, context}
#
# Environment:
#   LANCEDB_URI       — LanceDB REST API base (default: http://lancedb-api:8000)
#   OLLAMA_BASE_URL   — Ollama for embeddings (default: http://ollama:11434)
#   EMBEDDING_MODEL   — embedding model (default: nomic-embed-text)

set -e

RECORD_TYPE="${1:?Usage: lancedb-nitter-store.sh <post|user|relationship>}"

LANCEDB_URI="${LANCEDB_URI:-http://lancedb-api:8000}"
OLLAMA_BASE_URL="${OLLAMA_BASE_URL:-http://ollama:11434}"
EMBEDDING_MODEL="${EMBEDDING_MODEL:-nomic-embed-text}"
DB="user_dbs"

INPUT=$(cat)
if [ -z "$INPUT" ]; then
  echo '{"error": "No JSON input provided"}'
  exit 1
fi

# ── Helpers ────────────────────────────────────────────────
gen_uuid() {
  if [ -f /proc/sys/kernel/random/uuid ]; then
    cat /proc/sys/kernel/random/uuid
  else
    od -x /dev/urandom | head -1 | awk '{print $2$3"-"$4"-"$5"-"$6"-"$7$8$9}'
  fi
}

gen_embedding() {
  local text="$1"
  local escaped
  escaped=$(printf '%s' "$text" | sed 's/\\/\\\\/g; s/"/\\"/g' | tr '\n' ' ')
  local resp
  resp=$(curl -sf "$OLLAMA_BASE_URL/api/embed" \
    -H "Content-Type: application/json" \
    -d "{\"model\": \"$EMBEDDING_MODEL\", \"input\": \"$escaped\"}" 2>/dev/null)
  echo "$resp" | jq '.embeddings[0] // empty' 2>/dev/null
}

table_exists() {
  local table="$1"
  local list
  list=$(curl -sf "$LANCEDB_URI/dbs/$DB/tables" 2>/dev/null || echo '{"tables":[]}')
  echo "$list" | jq -r ".tables[]?.name | select(. == \"$table\")" 2>/dev/null
}

ingest_record() {
  local table="$1"
  local record="$2"
  local base="$LANCEDB_URI/dbs/$DB/tables/$table"
  local resp
  resp=$(curl -sf -w '\n%{http_code}' "$base/ingest" \
    -H "Content-Type: application/json" \
    -d "{\"records\": [$record]}" 2>/dev/null)
  local code
  code=$(echo "$resp" | tail -1)
  local body
  body=$(echo "$resp" | sed '$d')
  if [ "$code" = "200" ] || [ "$code" = "201" ]; then
    return 0
  else
    echo "$body" >&2
    return 1
  fi
}

# ── Store Post ─────────────────────────────────────────────
store_post() {
  local TABLE="nitter_posts"
  local BASE="$LANCEDB_URI/dbs/$DB/tables/$TABLE"

  local TWEET_ID
  TWEET_ID=$(echo "$INPUT" | jq -r '.tweet_id // ""')
  local TEXT
  TEXT=$(echo "$INPUT" | jq -r '.text // ""')
  local USERNAME
  USERNAME=$(echo "$INPUT" | jq -r '.username // ""')
  local PERMALINK
  PERMALINK=$(echo "$INPUT" | jq -r '.permalink // ""')

  if [ -z "$TWEET_ID" ] || [ -z "$USERNAME" ]; then
    echo '{"error": "Missing required fields: tweet_id, username"}'
    exit 1
  fi

  # Content hash from tweet_id (globally unique)
  local CONTENT_HASH
  CONTENT_HASH=$(printf '%s' "$TWEET_ID" | sha256sum | cut -d' ' -f1)

  # Dedup: check by content_hash
  local HAS_TABLE
  HAS_TABLE=$(table_exists "$TABLE")
  if [ -n "$HAS_TABLE" ]; then
    local HASH_RESULT
    HASH_RESULT=$(curl -sf "$BASE/query" \
      -H "Content-Type: application/json" \
      -d "{\"filter\": \"content_hash = '$CONTENT_HASH'\", \"limit\": 1}" 2>/dev/null || echo '{"records":[]}')
    local HASH_COUNT
    HASH_COUNT=$(echo "$HASH_RESULT" | jq '.records | length' 2>/dev/null || echo "0")
    if [ "$HASH_COUNT" -gt 0 ]; then
      local EXISTING_ID
      EXISTING_ID=$(echo "$HASH_RESULT" | jq -r '.records[0].id // "unknown"')
      echo "{\"stored\": false, \"reason\": \"DUPLICATE: tweet_id hash match\", \"existing_id\": \"$EXISTING_ID\", \"content_hash\": \"$CONTENT_HASH\"}"
      return 0
    fi
  fi

  # Generate embedding from tweet text
  local EMBEDDING="null"
  if [ -n "$TEXT" ]; then
    EMBEDDING=$(gen_embedding "$TEXT")
    if [ -z "$EMBEDDING" ] || [ "$EMBEDDING" = "null" ]; then
      EMBEDDING="null"
    fi
  fi

  local UUID
  UUID=$(gen_uuid)
  local TIMESTAMP
  TIMESTAMP=$(date -Iseconds)

  # Build record
  local RECORD
  if [ "$EMBEDDING" != "null" ]; then
    RECORD=$(echo "$INPUT" | jq \
      --arg id "$UUID" \
      --arg content_hash "$CONTENT_HASH" \
      --arg timestamp "$TIMESTAMP" \
      --argjson embedding "$EMBEDDING" \
      '. + {
        id: $id,
        content_hash: $content_hash,
        timestamp: $timestamp,
        embedding: $embedding,
        mentions: (.mentions // []),
        hashtags: (.hashtags // []),
        media_urls: (.media_urls // []),
        entities: (.entities // []),
        key_topics: (.key_topics // [])
      }')
  else
    RECORD=$(echo "$INPUT" | jq \
      --arg id "$UUID" \
      --arg content_hash "$CONTENT_HASH" \
      --arg timestamp "$TIMESTAMP" \
      '. + {
        id: $id,
        content_hash: $content_hash,
        timestamp: $timestamp,
        mentions: (.mentions // []),
        hashtags: (.hashtags // []),
        media_urls: (.media_urls // []),
        entities: (.entities // []),
        key_topics: (.key_topics // [])
      }')
  fi

  if ingest_record "$TABLE" "$RECORD"; then
    echo "{\"stored\": true, \"id\": \"$UUID\", \"content_hash\": \"$CONTENT_HASH\", \"table\": \"$TABLE\"}"
  else
    echo "{\"stored\": false, \"error\": \"LanceDB insert failed\", \"content_hash\": \"$CONTENT_HASH\"}"
    exit 1
  fi
}

# ── Store User ─────────────────────────────────────────────
store_user() {
  local TABLE="nitter_users"
  local BASE="$LANCEDB_URI/dbs/$DB/tables/$TABLE"

  local USERNAME
  USERNAME=$(echo "$INPUT" | jq -r '.username // ""')

  if [ -z "$USERNAME" ]; then
    echo '{"error": "Missing required field: username"}'
    exit 1
  fi

  local USERNAME_LOWER
  USERNAME_LOWER=$(printf '%s' "$USERNAME" | tr '[:upper:]' '[:lower:]')

  # Dedup: check by username
  local HAS_TABLE
  HAS_TABLE=$(table_exists "$TABLE")
  if [ -n "$HAS_TABLE" ]; then
    local USER_RESULT
    USER_RESULT=$(curl -sf "$BASE/query" \
      -H "Content-Type: application/json" \
      -d "{\"filter\": \"username = '$USERNAME_LOWER'\", \"limit\": 1}" 2>/dev/null || echo '{"records":[]}')
    local USER_COUNT
    USER_COUNT=$(echo "$USER_RESULT" | jq '.records | length' 2>/dev/null || echo "0")
    if [ "$USER_COUNT" -gt 0 ]; then
      local EXISTING_ID
      EXISTING_ID=$(echo "$USER_RESULT" | jq -r '.records[0].id // "unknown"')
      echo "{\"stored\": false, \"reason\": \"DUPLICATE: username exists\", \"existing_id\": \"$EXISTING_ID\", \"username\": \"$USERNAME_LOWER\"}"
      return 0
    fi
  fi

  # Generate embedding from bio + username
  local BIO
  BIO=$(echo "$INPUT" | jq -r '.bio // ""')
  local EMBED_TEXT="@${USERNAME_LOWER} ${BIO}"
  local EMBEDDING
  EMBEDDING=$(gen_embedding "$EMBED_TEXT")
  if [ -z "$EMBEDDING" ] || [ "$EMBEDDING" = "null" ]; then
    EMBEDDING="null"
  fi

  local UUID
  UUID=$(gen_uuid)
  local TIMESTAMP
  TIMESTAMP=$(date -Iseconds)

  local RECORD
  if [ "$EMBEDDING" != "null" ]; then
    RECORD=$(echo "$INPUT" | jq \
      --arg id "$UUID" \
      --arg username "$USERNAME_LOWER" \
      --arg first_seen "$TIMESTAMP" \
      --arg last_crawled "" \
      --argjson embedding "$EMBEDDING" \
      '. + {
        id: $id,
        username: $username,
        display_name: (.display_name // $username),
        bio: (.bio // ""),
        follower_estimate: (.follower_estimate // 0),
        category: (.category // "unknown"),
        discovered_from: (.discovered_from // "seed"),
        discovery_method: (.discovery_method // "manual"),
        first_seen: $first_seen,
        last_crawled: $last_crawled,
        crawl_priority: (.crawl_priority // 0.5),
        tags: (.tags // []),
        embedding: $embedding
      }')
  else
    RECORD=$(echo "$INPUT" | jq \
      --arg id "$UUID" \
      --arg username "$USERNAME_LOWER" \
      --arg first_seen "$TIMESTAMP" \
      --arg last_crawled "" \
      '. + {
        id: $id,
        username: $username,
        display_name: (.display_name // $username),
        bio: (.bio // ""),
        follower_estimate: (.follower_estimate // 0),
        category: (.category // "unknown"),
        discovered_from: (.discovered_from // "seed"),
        discovery_method: (.discovery_method // "manual"),
        first_seen: $first_seen,
        last_crawled: $last_crawled,
        crawl_priority: (.crawl_priority // 0.5),
        tags: (.tags // [])
      }')
  fi

  if ingest_record "$TABLE" "$RECORD"; then
    echo "{\"stored\": true, \"id\": \"$UUID\", \"username\": \"$USERNAME_LOWER\", \"table\": \"$TABLE\"}"
  else
    echo "{\"stored\": false, \"error\": \"LanceDB insert failed\", \"username\": \"$USERNAME_LOWER\"}"
    exit 1
  fi
}

# ── Store Relationship ─────────────────────────────────────
store_relationship() {
  local TABLE="nitter_relationships"
  local BASE="$LANCEDB_URI/dbs/$DB/tables/$TABLE"

  local SOURCE_USER
  SOURCE_USER=$(echo "$INPUT" | jq -r '.source_user // ""')
  local TARGET_USER
  TARGET_USER=$(echo "$INPUT" | jq -r '.target_user // ""')
  local REL_TYPE
  REL_TYPE=$(echo "$INPUT" | jq -r '.relationship_type // ""')

  if [ -z "$SOURCE_USER" ] || [ -z "$TARGET_USER" ] || [ -z "$REL_TYPE" ]; then
    echo '{"error": "Missing required fields: source_user, target_user, relationship_type"}'
    exit 1
  fi

  local SRC_LOWER
  SRC_LOWER=$(printf '%s' "$SOURCE_USER" | tr '[:upper:]' '[:lower:]')
  local TGT_LOWER
  TGT_LOWER=$(printf '%s' "$TARGET_USER" | tr '[:upper:]' '[:lower:]')

  local TIMESTAMP
  TIMESTAMP=$(date -Iseconds)

  # Check if relationship already exists — if so, we'd ideally increment weight
  # LanceDB doesn't support UPDATE, so we track via content_hash dedup
  # New occurrences of the same edge get stored as separate records (weight = count of records)
  local CONTENT_HASH
  CONTENT_HASH=$(printf '%s%s%s' "$SRC_LOWER" "$TGT_LOWER" "$REL_TYPE" | sha256sum | cut -d' ' -f1)

  # For relationships, we DON'T dedup — each occurrence is a separate record
  # The "weight" of a relationship = COUNT of records with same source+target+type
  # This avoids needing UPDATE operations on LanceDB

  local UUID
  UUID=$(gen_uuid)
  local CONTEXT
  CONTEXT=$(echo "$INPUT" | jq -r '.context // ""')

  local RECORD
  RECORD=$(jq -n \
    --arg id "$UUID" \
    --arg source_user "$SRC_LOWER" \
    --arg target_user "$TGT_LOWER" \
    --arg relationship_type "$REL_TYPE" \
    --arg edge_hash "$CONTENT_HASH" \
    --arg first_seen "$TIMESTAMP" \
    --arg last_seen "$TIMESTAMP" \
    --arg context "$CONTEXT" \
    '{
      id: $id,
      source_user: $source_user,
      target_user: $target_user,
      relationship_type: $relationship_type,
      edge_hash: $edge_hash,
      first_seen: $first_seen,
      last_seen: $last_seen,
      context: $context
    }')

  if ingest_record "$TABLE" "$RECORD"; then
    echo "{\"stored\": true, \"id\": \"$UUID\", \"edge\": \"${SRC_LOWER}->${TGT_LOWER}\", \"type\": \"$REL_TYPE\", \"table\": \"$TABLE\"}"
  else
    echo "{\"stored\": false, \"error\": \"LanceDB insert failed\", \"edge\": \"${SRC_LOWER}->${TGT_LOWER}\"}"
    exit 1
  fi
}

# ── Dispatch ───────────────────────────────────────────────
case "$RECORD_TYPE" in
  post)         store_post ;;
  user)         store_user ;;
  relationship) store_relationship ;;
  *)
    echo "{\"error\": \"Unknown record type: $RECORD_TYPE. Use: post, user, relationship\"}"
    exit 1
    ;;
esac
