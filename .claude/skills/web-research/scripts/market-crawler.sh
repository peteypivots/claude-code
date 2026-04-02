#!/bin/sh
# market-crawler.sh — Continuous market news research agent
# Runs in a loop, cycling through market-related search queries.
# Uses research-pipeline.sh for search → dedup → store.
#
# Usage: market-crawler.sh [interval_seconds] [results_per_query]
# Default: 60s interval, 5 results per query
#
# Stop: kill the process or touch /tmp/market-crawler-stop

set -e

INTERVAL="${1:-60}"
RESULTS_PER_QUERY="${2:-5}"
SCRIPT_DIR="$(dirname "$0")"
PIPELINE="$SCRIPT_DIR/research-pipeline.sh"
STOP_FILE="/tmp/market-crawler-stop"
LOG_FILE="/data/logs/market-crawler.log"

# Ensure log dir exists
mkdir -p "$(dirname "$LOG_FILE")" 2>/dev/null || true

# Remove stale stop file
rm -f "$STOP_FILE"

# ── Query rotation ────────────────────────────────────────
# Each cycle picks queries from this list in order, then repeats.
# Covers: breaking news, markets, specific sources, economic calendar
QUERIES='
breaking news today financial markets
stock market news today
cryptocurrency bitcoin ethereum news today
Drudge Report top stories today
Zero Hedge latest articles
market events economic calendar this week
Federal Reserve interest rate news
S&P 500 Nasdaq Dow Jones market update
commodities gold oil silver prices today
geopolitical news affecting markets
bond market treasury yields today
earnings reports quarterly results
IPO SPAC market activity 2025
forex currency exchange rate news
housing market real estate news
inflation CPI PPI economic data
China trade tariffs economic news
tech stocks FAANG earnings news
energy markets natural gas crude oil
options market volatility VIX today
'

log() {
    TIMESTAMP=$(date -u +%Y-%m-%dT%H:%M:%SZ)
    echo "[$TIMESTAMP] $1" | tee -a "$LOG_FILE"
}

log "=== MARKET CRAWLER STARTED ==="
log "Interval: ${INTERVAL}s | Results per query: $RESULTS_PER_QUERY"
log "Stop file: $STOP_FILE (touch to stop)"
log "Log file: $LOG_FILE"
log ""

CYCLE=0
TOTAL_STORED=0
TOTAL_DUPES=0
TOTAL_ERRORS=0

while true; do
    # Check stop signal
    if [ -f "$STOP_FILE" ]; then
        log "=== STOP SIGNAL RECEIVED ==="
        log "Total cycles: $CYCLE"
        log "Total stored: $TOTAL_STORED"
        log "Total duplicates: $TOTAL_DUPES"
        log "Total errors: $TOTAL_ERRORS"
        rm -f "$STOP_FILE"
        exit 0
    fi
    
    CYCLE=$((CYCLE + 1))
    log "━━━ CYCLE $CYCLE ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
    
    QUERY_NUM=0
    echo "$QUERIES" | while IFS= read -r QUERY; do
        # Skip empty lines
        QUERY=$(echo "$QUERY" | sed 's/^[[:space:]]*//;s/[[:space:]]*$//')
        [ -z "$QUERY" ] && continue
        
        # Check stop signal between queries
        if [ -f "$STOP_FILE" ]; then
            log "Stop signal detected mid-cycle"
            break
        fi
        
        QUERY_NUM=$((QUERY_NUM + 1))
        log ""
        log "── Query $QUERY_NUM: $QUERY ──"
        
        # Determine category from query
        CATEGORY="markets"
        case "$QUERY" in
            *cryptocurrency*|*bitcoin*|*ethereum*) CATEGORY="crypto" ;;
            *Drudge*) CATEGORY="drudge-report" ;;
            *Zero*Hedge*) CATEGORY="zero-hedge" ;;
            *Federal*Reserve*|*interest*rate*) CATEGORY="fed" ;;
            *commodities*|*gold*|*oil*|*silver*) CATEGORY="commodities" ;;
            *geopolitical*) CATEGORY="geopolitics" ;;
            *bond*|*treasury*) CATEGORY="bonds" ;;
            *earnings*|*quarterly*) CATEGORY="earnings" ;;
            *IPO*|*SPAC*) CATEGORY="ipo" ;;
            *forex*|*currency*) CATEGORY="forex" ;;
            *housing*|*real*estate*) CATEGORY="housing" ;;
            *inflation*|*CPI*|*PPI*) CATEGORY="economic-data" ;;
            *China*|*tariff*) CATEGORY="trade" ;;
            *tech*|*FAANG*) CATEGORY="tech-stocks" ;;
            *energy*|*natural*gas*|*crude*) CATEGORY="energy" ;;
            *options*|*VIX*|*volatility*) CATEGORY="volatility" ;;
            *breaking*) CATEGORY="breaking-news" ;;
        esac
        
        # Run pipeline
        RESULT=$(sh "$PIPELINE" "$QUERY" "$CATEGORY" "$RESULTS_PER_QUERY" 2>&1) || true
        
        # Extract summary line
        STORED=$(echo "$RESULT" | grep "^Stored:" | head -1 | awk '{print $2}')
        DUPES=$(echo "$RESULT" | grep "^Duplicates:" | head -1 | awk '{print $2}')
        ERRS=$(echo "$RESULT" | grep "^Errors:" | head -1 | awk '{print $2}')
        
        STORED=${STORED:-0}
        DUPES=${DUPES:-0}
        ERRS=${ERRS:-0}
        
        log "  → Stored: $STORED | Dupes: $DUPES | Errors: $ERRS"
        
        # Brief pause between queries to not hammer SearXNG
        sleep 3
    done
    
    # Update totals from this cycle's pipeline output
    CYCLE_STORED=$(echo "$QUERIES" | while IFS= read -r Q; do
        Q=$(echo "$Q" | sed 's/^[[:space:]]*//;s/[[:space:]]*$//')
        [ -z "$Q" ] && continue
        echo "1"
    done | wc -l)
    
    log ""
    log "━━━ CYCLE $CYCLE COMPLETE ━━━"
    log "Waiting ${INTERVAL}s before next cycle..."
    log ""
    
    sleep "$INTERVAL"
done
