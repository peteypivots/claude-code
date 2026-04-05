#!/bin/bash
# grok-rephrase.sh — Ask Grok to suggest alternative query angles when hitting duplicates
#
# Usage: grok-rephrase.sh "original query" [context]
# Output: A single-line rephrased query suggestion
#
# Environment:
#   NITTER_MCP_URL  - MCP server URL (default: http://172.23.0.1:8085)
#   CDP_HOST        - Chrome CDP host (default: hoarder-app-chrome-1)
#   GROK_TIMEOUT    - Request timeout in seconds (default: 30)

set -uo pipefail

ORIGINAL_QUERY="$1"
CONTEXT="${2:-}"

NITTER_MCP_URL="${NITTER_MCP_URL:-http://172.23.0.1:8085}"
MCP_HOST_HEADER="${MCP_HOST_HEADER:-localhost:8085}"
GROK_TIMEOUT="${GROK_TIMEOUT:-30}"

# Build prompt for Grok
PROMPT="I've been searching for: \"$ORIGINAL_QUERY\"

But I'm getting duplicate results I've already seen. Suggest ONE alternative search query that would:
1. Cover the same topic from a different angle
2. Use different keywords to find fresh content
3. Be specific enough to avoid SEO spam

${CONTEXT:+"Context: $CONTEXT"}

Reply with ONLY the search query, no explanation. Maximum 10 words."

# Step 1: Initialize MCP session
INIT_RESP=$(curl -s -w '\n%{http_code}' -X POST "$NITTER_MCP_URL" \
  -H "Host: $MCP_HOST_HEADER" \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -d '{
    "jsonrpc": "2.0",
    "id": 1,
    "method": "initialize",
    "params": {
      "protocolVersion": "2025-03-26",
      "capabilities": {},
      "clientInfo": {"name": "grok-rephrase", "version": "1.0"}
    }
  }' 2>/dev/null)

HTTP_CODE=$(echo "$INIT_RESP" | tail -1)
INIT_BODY=$(echo "$INIT_RESP" | head -n -1)

if [ "$HTTP_CODE" != "200" ]; then
  echo >&2 "ERROR: MCP init failed (HTTP $HTTP_CODE)"
  echo ""
  exit 1
fi

# Extract session ID from response headers
SESSION_ID=$(echo "$INIT_RESP" | grep -i 'mcp-session-id' | cut -d: -f2 | tr -d ' \r\n' || true)

# If no session ID in grep, try parsing the init again with -i flag
if [ -z "$SESSION_ID" ]; then
  SESSION_ID=$(curl -s -i -X POST "$NITTER_MCP_URL" \
    -H "Host: $MCP_HOST_HEADER" \
    -H "Content-Type: application/json" \
    -H "Accept: application/json, text/event-stream" \
    -d '{
      "jsonrpc": "2.0",
      "id": 1,
      "method": "initialize",
      "params": {
        "protocolVersion": "2025-03-26",
        "capabilities": {},
        "clientInfo": {"name": "grok-rephrase", "version": "1.0"}
      }
    }' 2>/dev/null | grep -i 'mcp-session-id' | sed 's/.*: *//' | tr -d '\r\n')
fi

if [ -z "$SESSION_ID" ]; then
  echo >&2 "ERROR: No MCP session ID returned"
  echo ""
  exit 1
fi

# Step 2: Send initialized notification
curl -s -X POST "$NITTER_MCP_URL" \
  -H "Host: $MCP_HOST_HEADER" \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -H "Mcp-Session-Id: $SESSION_ID" \
  -d '{"jsonrpc": "2.0", "method": "notifications/initialized"}' >/dev/null 2>&1

# Step 3: Call grok_chat tool
ESCAPED_PROMPT=$(echo "$PROMPT" | jq -Rs '.')

GROK_RESP=$(timeout "$GROK_TIMEOUT" curl -s -X POST "$NITTER_MCP_URL" \
  -H "Host: $MCP_HOST_HEADER" \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -H "Mcp-Session-Id: $SESSION_ID" \
  -d "{
    \"jsonrpc\": \"2.0\",
    \"id\": 2,
    \"method\": \"tools/call\",
    \"params\": {
      \"name\": \"grok_chat\",
      \"arguments\": {
        \"message\": $ESCAPED_PROMPT,
        \"model\": \"grok-3-latest\"
      }
    }
  }" 2>/dev/null)

# Parse SSE response - extract the data line containing the result
RESULT_DATA=$(echo "$GROK_RESP" | grep '^data:' | grep '"id":2' | sed 's/^data: *//')

# Extract response from structuredContent or content[0].text
if [ -n "$RESULT_DATA" ]; then
  # Try structuredContent.response first (cleaner)
  GROK_TEXT=$(echo "$RESULT_DATA" | jq -r '.result.structuredContent.response // empty' 2>/dev/null)
  
  # Fallback to content[0].text and parse inner JSON
  if [ -z "$GROK_TEXT" ]; then
    INNER_JSON=$(echo "$RESULT_DATA" | jq -r '.result.content[0].text // empty' 2>/dev/null)
    if [ -n "$INNER_JSON" ]; then
      GROK_TEXT=$(echo "$INNER_JSON" | jq -r '.response // .message // .' 2>/dev/null)
    fi
  fi
  
  # Check for error
  if echo "$RESULT_DATA" | jq -e '.error' >/dev/null 2>&1; then
    echo >&2 "GROK ERROR: $(echo "$RESULT_DATA" | jq -r '.error.message')"
    echo ""
    exit 1
  fi
  
  if [ -n "$GROK_TEXT" ] && [ "$GROK_TEXT" != "null" ]; then
    # Output just the first line, trimmed
    echo "$GROK_TEXT" | head -1 | tr -d '\n'
    exit 0
  fi
fi

echo >&2 "GROK: Could not extract response"
echo ""
exit 1
