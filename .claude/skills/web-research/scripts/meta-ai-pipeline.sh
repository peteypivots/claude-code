#!/bin/sh
# meta-ai-pipeline.sh — Parse and display Meta AI research response
#
# Usage: meta-ai-pipeline.sh "query" "response_text_or_json"
#   OR:  echo "response text or json" | meta-ai-pipeline.sh "query"
#
# Accepts two input formats:
#   1. Structured JSON from meta_ai_chat MCP tool:
#      {"response":"...", "reasoning":["..."], "sources":[...], "frame_count":N}
#   2. Plain text response (legacy)
#
# NOTE: LanceDB storage is handled automatically by the infrastructure
# (researchCapture.ts in queryModelRouter). This script only parses and
# displays the response for the model to consume.
#
# Error responses ({"response":"Error: ...", "error":true}) are detected and skipped.

set -e

QUERY="${1:?Usage: meta-ai-pipeline.sh 'query' ['response_text_or_json']}"

# Read response from arg or stdin
if [ -n "$2" ]; then
  RAW_INPUT="$2"
else
  RAW_INPUT=$(cat)
fi

if [ -z "$RAW_INPUT" ]; then
  echo '{"error": "No response text provided"}'
  exit 1
fi

# --- Detect structured JSON vs plain text ---
IS_JSON=false
RESPONSE=""

# Check if input is valid JSON with a "response" key
if printf '%s' "$RAW_INPUT" | jq -e '.response' >/dev/null 2>&1; then
  IS_JSON=true

  # Check for error response
  if printf '%s' "$RAW_INPUT" | jq -e '.error == true' >/dev/null 2>&1; then
    ERR_MSG=$(printf '%s' "$RAW_INPUT" | jq -r '.response' 2>/dev/null)
    echo '{"error": "Meta AI returned error", "detail": "'"$ERR_MSG"'"}'
    exit 1
  fi

  # Extract structured fields for display
  RESPONSE=$(printf '%s' "$RAW_INPUT" | jq -r '.response // ""')
  REASONING_COUNT=$(printf '%s' "$RAW_INPUT" | jq '.reasoning | length' 2>/dev/null || echo "0")
  SOURCES_COUNT=$(printf '%s' "$RAW_INPUT" | jq '.sources | length' 2>/dev/null || echo "0")
else
  # Plain text fallback
  RESPONSE="$RAW_INPUT"
  REASONING_COUNT=0
  SOURCES_COUNT=0
fi

if [ -z "$RESPONSE" ]; then
  echo '{"error": "Empty response text"}'
  exit 1
fi

echo "=== META AI RESEARCH RESULT ==="
echo "Query: $QUERY"
echo "Format: $([ "$IS_JSON" = true ] && echo "structured JSON" || echo "plain text")"
echo "Response length: ${#RESPONSE} chars"
[ "$REASONING_COUNT" != "0" ] && echo "Reasoning steps: $REASONING_COUNT"
[ "$SOURCES_COUNT" != "0" ] && echo "Sources: $SOURCES_COUNT"
echo ""
echo "--- Response ---"
echo "$RESPONSE"
echo ""
echo "=== END META AI RESULT ==="
