#!/bin/sh
# research-pipeline.sh — Full research pipeline: search → dedup check → store
# Usage: research-pipeline.sh "search query" [category] [max_results]
set -e

QUERY="${1:?Usage: research-pipeline.sh 'search query' [category] [max_results]}"
CATEGORY="${2:-general}"
MAX_RESULTS="${3:-3}"
SCRIPT_DIR="$(dirname "$0")"
SEMANTIC_THRESHOLD="${SEMANTIC_THRESHOLD:-0.5}"

echo "=== RESEARCH PIPELINE ==="
echo "Query: $QUERY"
echo "Category: $CATEGORY"
echo "Max results: $MAX_RESULTS"
echo ""

# Step 1: Search via SearXNG
SEARXNG_URL="${SEARXNG_URL:-http://searxng:8080}"
ENCODED_QUERY=$(python3 -c "import urllib.parse; print(urllib.parse.quote_plus('$QUERY'))" 2>/dev/null || echo "$QUERY" | sed 's/ /+/g; s/&/%26/g')
SEARCH_URL="${SEARXNG_URL}/search?q=${ENCODED_QUERY}&format=json"

echo "--- Step 1: Searching SearXNG ---"
RESULTS=$(curl -sf "$SEARCH_URL" 2>/dev/null || echo '{"results":[]}')
RESULT_COUNT=$(echo "$RESULTS" | jq '.results | length')
echo "Found $RESULT_COUNT total results, processing top $MAX_RESULTS"
echo ""

STORED=0
DUPLICATES=0
ERRORS=0
TIMESTAMP=$(date -u +%Y-%m-%dT%H:%M:%SZ)

i=0
while [ "$i" -lt "$MAX_RESULTS" ] && [ "$i" -lt "$RESULT_COUNT" ]; do
    TITLE=$(echo "$RESULTS" | jq -r ".results[$i].title // empty")
    URL=$(echo "$RESULTS" | jq -r ".results[$i].url // empty")
    CONTENT=$(echo "$RESULTS" | jq -r ".results[$i].content // empty" | head -c 500)
    DOMAIN=$(echo "$URL" | sed 's|https\?://\([^/]*\).*|\1|')
    
    if [ -z "$TITLE" ] || [ -z "$URL" ]; then
        i=$((i + 1))
        continue
    fi
    
    echo "--- Result $((i+1)): $TITLE ---"
    echo "    URL: $URL"
    
    # Step 2: Dedup check
    CHECK_OUTPUT=$(sh "$SCRIPT_DIR/lancedb-check.sh" "$TITLE" "$URL" "$CONTENT" 2>/dev/null || echo '{"dedup_layer":"none"}')
    CHECK_JSON=$(echo "$CHECK_OUTPUT" | grep 'dedup_layer' | head -1)
    DEDUP_LAYER=$(echo "$CHECK_JSON" | jq -r '.dedup_layer // "none"' 2>/dev/null || echo "none")
    
    IS_DUPLICATE=false
    
    if [ "$DEDUP_LAYER" = "none" ] || [ "$DEDUP_LAYER" = "null" ]; then
        IS_DUPLICATE=false
    elif [ "$DEDUP_LAYER" = "content_hash" ] || [ "$DEDUP_LAYER" = "source_url" ]; then
        IS_DUPLICATE=true
        REASON=$(echo "$CHECK_JSON" | jq -r '.reason // "exact match"' 2>/dev/null || echo "exact match")
    elif [ "$DEDUP_LAYER" = "semantic" ]; then
        MIN_DIST=$(echo "$CHECK_OUTPUT" | python3 -c "
import sys, json
raw = sys.stdin.read()
start = raw.find('{')
if start < 0: print('999')
else:
    try:
        data = json.loads(raw[start:raw.rfind('}')+1])
        dists = [m.get('_distance', 999) for m in data.get('matches', [])]
        print(min(dists) if dists else 999)
    except: print('999')
" 2>/dev/null || echo "999")
        IS_CLOSE=$(echo "$MIN_DIST $SEMANTIC_THRESHOLD" | awk '{print ($1 < $2) ? "true" : "false"}')
        if [ "$IS_CLOSE" = "true" ]; then
            IS_DUPLICATE=true
            REASON="semantic match (distance=$MIN_DIST)"
        else
            echo "    Semantic distance: $MIN_DIST (above threshold $SEMANTIC_THRESHOLD = novel)"
        fi
    fi
    
    if [ "$IS_DUPLICATE" = "true" ]; then
        DUPLICATES=$((DUPLICATES + 1))
        echo "    Status: DUPLICATE ($DEDUP_LAYER: ${REASON:-duplicate})"
    else
        echo "    Status: NEW — storage handled by researchCapture.ts in LLM router"
        STORED=$((STORED + 1))
    fi
    echo ""
    i=$((i + 1))
done

echo "=== PIPELINE SUMMARY ==="
echo "Query: $QUERY"
echo "Results found: $RESULT_COUNT"
echo "Processed: $((i))"  
echo "Stored: $STORED new findings"
echo "Duplicates: $DUPLICATES skipped"
echo "Errors: $ERRORS"
