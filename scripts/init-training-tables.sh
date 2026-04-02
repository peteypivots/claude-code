#!/bin/sh
# init-training-tables.sh — Create LanceDB tables for training data pipeline
#
# Creates 3 tables via seed record ingest (tables auto-create):
#   1. training_examples  — (system, user, assistant) turn tuples for SFT/DPO
#   2. tool_interactions  — tool call/result pairs for tool learning
#   3. routing_decisions  — orchestrator routing decisions for classifier training
#
# Environment:
#   LANCEDB_URI  — LanceDB REST API base URL (default: http://lancedb-api:8000)
#
# Idempotent: skips tables that already exist.

set -e

LANCEDB_URI="${LANCEDB_URI:-http://lancedb-api:8000}"
DB="user_dbs"

echo "Initializing training data tables in LanceDB..."
echo "  URI: $LANCEDB_URI"
echo "  DB:  $DB"

# ── Helper: create table if not exists via seed ingest ─────
ensure_table() {
  TABLE_NAME="$1"
  SEED_RECORD="$2"

  # Check if table exists
  TABLE_LIST=$(curl -sf "$LANCEDB_URI/dbs/$DB/tables" 2>/dev/null || echo '{"tables":[]}')
  HAS_TABLE=$(echo "$TABLE_LIST" | jq -r ".tables[]?.name | select(. == \"$TABLE_NAME\")" 2>/dev/null)

  if [ -n "$HAS_TABLE" ]; then
    echo "  ✓ Table '$TABLE_NAME' already exists — skipping"
    return 0
  fi

  echo "  → Creating table '$TABLE_NAME' via seed ingest..."

  # Generate a 768-dim zero embedding for schema initialization
  ZERO_EMBED=$(python3 -c "print([0.0]*768)" 2>/dev/null || echo "null")
  if [ "$ZERO_EMBED" = "null" ]; then
    # Fallback: generate via seq
    ZERO_EMBED="[$(seq -s, 768 | sed 's/[0-9]*/0.0/g')]"
  fi

  # Replace __EMBEDDING__ placeholder in seed record
  SEEDED=$(echo "$SEED_RECORD" | sed "s/\"__EMBEDDING__\"/$ZERO_EMBED/")

  RESULT=$(curl -sf "$LANCEDB_URI/dbs/$DB/tables/$TABLE_NAME/ingest" \
    -H "Content-Type: application/json" \
    -d "{\"records\": [$SEEDED]}" 2>/dev/null)

  if echo "$RESULT" | jq -e '.status == "ok"' >/dev/null 2>&1; then
    echo "  ✓ Table '$TABLE_NAME' created"
  else
    echo "  ✗ Failed to create table '$TABLE_NAME': $RESULT"
    return 1
  fi
}

# ── Table 1: training_examples ─────────────────────────────
ensure_table "training_examples" '{
  "id": "__seed__",
  "session_id": "",
  "system_prompt": "",
  "user_content": "",
  "assistant_content": "",
  "canonical_prompt": "",
  "model_used": "",
  "routing_decision": "",
  "routing_confidence": 0.0,
  "latency_ms": 0,
  "feedback": "",
  "quality_score": 0.0,
  "tags": "",
  "content_hash": "__seed__",
  "turn_index": 0,
  "timestamp": "1970-01-01T00:00:00Z",
  "embedding": "__EMBEDDING__"
}'

# ── Table 2: tool_interactions ─────────────────────────────
ensure_table "tool_interactions" '{
  "id": "__seed__",
  "session_id": "",
  "turn_id": "",
  "tool_name": "",
  "tool_input": "",
  "tool_output": "",
  "tool_outcome": "",
  "latency_ms": 0,
  "used_in_final_answer": false,
  "timestamp": "1970-01-01T00:00:00Z",
  "embedding": "__EMBEDDING__"
}'

# ── Table 3: routing_decisions ─────────────────────────────
ensure_table "routing_decisions" '{
  "id": "__seed__",
  "session_id": "",
  "input_summary": "",
  "tool_count": 0,
  "conversation_depth": 0,
  "decision": "",
  "confidence": 0.0,
  "model_used": "",
  "latency_ms": 0,
  "outcome": "",
  "timestamp": "1970-01-01T00:00:00Z",
  "embedding": "__EMBEDDING__"
}'

echo ""
echo "Done. All training tables initialized."
