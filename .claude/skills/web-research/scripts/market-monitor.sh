#!/bin/sh
# market-monitor.sh — Continuous market research monitor
# Cycles through market-related queries, stores novel findings
# Usage: market-monitor.sh [interval_seconds] [results_per_query]
# Stop: touch /tmp/market-monitor-stop

INTERVAL="${1:-300}"
PER_QUERY="${2:-5}"
SCRIPT_DIR="$(dirname "$0")"
CYCLE=0
TOTAL_STORED=0
TOTAL_DUPES=0
STOP_FILE="/tmp/market-monitor-stop"

rm -f "$STOP_FILE"

QUERIES='
market news today financial markets
stock market events today economic calendar
breaking financial news market movers
drudge report news today headlines
zero hedge financial news latest
fed reserve interest rates economy
treasury yields bond market today
commodity prices gold silver oil today
crypto bitcoin ethereum market today
geopolitical risk market impact today
earnings reports quarterly results
IPO market new listings 2025
forex currency markets dollar today
SP500 nasdaq dow jones today
market volatility VIX fear index
trade war tariffs economic impact
inflation CPI consumer prices latest
housing market real estate trends
tech stocks FAANG megacap today
energy markets oil natural gas prices
'

log() {
    echo "[$(date -u +%Y-%m-%dT%H:%M:%SZ)] $*"
}

log "=== MARKET MONITOR STARTED ==="
log "Interval: ${INTERVAL}s | Per query: $PER_QUERY"
log "Stop: touch $STOP_FILE"
log ""

while true; do
    [ -f "$STOP_FILE" ] && { log "Stop signal received."; rm -f "$STOP_FILE"; exit 0; }

    CYCLE=$((CYCLE + 1))
    log "════════════════════════════════════════"
    log "CYCLE $CYCLE starting"
    log "════════════════════════════════════════"
    
    CYCLE_QUERIES=$(echo "$QUERIES" | grep -v '^$' | shuf | head -6)
    
    echo "$CYCLE_QUERIES" | while IFS= read -r QUERY; do
        [ -z "$QUERY" ] && continue
        [ -f "$STOP_FILE" ] && break
        
        log "── $QUERY ──"
        
        OUTPUT=$(sh "$SCRIPT_DIR/research-pipeline.sh" "$QUERY" "markets" "$PER_QUERY" 2>&1)
        
        # Parse the PIPELINE SUMMARY section
        STORED=$(echo "$OUTPUT" | grep "Stored:" | grep -oE '[0-9]+' | head -1)
        DUPES=$(echo "$OUTPUT" | grep "Duplicates:" | grep -oE '[0-9]+' | head -1)
        ERRS=$(echo "$OUTPUT" | grep "Errors:" | grep -oE '[0-9]+' | head -1)
        FOUND=$(echo "$OUTPUT" | grep "Results found:" | grep -oE '[0-9]+' | head -1)
        
        STORED="${STORED:-0}"; DUPES="${DUPES:-0}"; ERRS="${ERRS:-0}"; FOUND="${FOUND:-0}"
        
        log "  Found:$FOUND Stored:$STORED Dupes:$DUPES Errors:$ERRS"
        
        # Show newly stored items
        echo "$OUTPUT" | grep "STORED successfully" | while read -r LINE; do
            TITLE_LINE=$(echo "$OUTPUT" | grep -B3 "STORED successfully" | grep "Result [0-9]" | tail -1 | sed 's/.*Result [0-9]*: //')
            [ -n "$TITLE_LINE" ] && log "  ✓ $TITLE_LINE"
        done
        
        sleep 2
    done
    
    log ""
    log "CYCLE $CYCLE done."
    
    # Check LanceDB total
    TOTAL=$(curl -sf "http://lancedb-api:8000/dbs/user_dbs/tables/research_findings/query" \
        -H "Content-Type: application/json" \
        -d '{"limit": 1000}' 2>/dev/null | jq '.records | length' 2>/dev/null || echo "?")
    log "LanceDB total records: $TOTAL"
    log "Sleeping ${INTERVAL}s..."
    
    ELAPSED=0
    while [ "$ELAPSED" -lt "$INTERVAL" ]; do
        [ -f "$STOP_FILE" ] && break
        sleep 10
        ELAPSED=$((ELAPSED + 10))
    done
done
