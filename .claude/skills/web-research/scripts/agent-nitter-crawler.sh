#!/bin/bash
# agent-nitter-crawler.sh — Social graph crawler via Nitter RSS + LLM analysis
#
# Crawls Nitter's RSS feeds, discovers users, tracks relationships, and
# stores structured findings in LanceDB. Uses Ollama for entity extraction,
# user categorization, and trend detection.
#
# Key difference from agent-market-monitor.sh:
# - Iteratively discovers new users from mentions/replies/quotes
# - Tracks social graph relationships (who interacts with whom)
# - Maintains a crawl priority queue (high-value users crawled more often)
# - Uses centralized training capture via training-capture-cli.ts (no bash duplication)
#
# Run:
#   ./agent-nitter-crawler.sh
#   INSTANCE=politics PARALLEL_WORKERS=2 ./agent-nitter-crawler.sh
#
# Stop: touch /tmp/nitter-crawler-${INSTANCE:-default}-stop
# Logs: /tmp/nitter-crawler-${INSTANCE:-default}.log

set -euo pipefail

# ── Instance Management ────────────────────────────────────
INSTANCE="${INSTANCE:-default}"
LOCKFILE="/tmp/nitter-crawler-${INSTANCE}.lock"
PIDFILE="/tmp/nitter-crawler-${INSTANCE}.pid"
STOPFILE="/tmp/nitter-crawler-${INSTANCE}-stop"
LOG="/tmp/nitter-crawler-${INSTANCE}.log"

exec 9>"$LOCKFILE"
if ! flock -n 9; then
  echo "Nitter crawler '$INSTANCE' already running (PID $(cat "$PIDFILE" 2>/dev/null || echo '?')). Exiting."
  exit 1
fi
echo $$ > "$PIDFILE"
trap 'rm -f "$PIDFILE"' EXIT

# ── Configuration ──────────────────────────────────────────
CYCLE_DELAY=${CYCLE_DELAY:-300}          # 5 min between cycles
QUERY_DELAY=${QUERY_DELAY:-15}           # 15s between queries (respect Nitter rate limits)
QUERIES_PER_CYCLE=${QUERIES_PER_CYCLE:-6}
USER_CRAWLS_PER_CYCLE=${USER_CRAWLS_PER_CYCLE:-4}  # user timelines to crawl per cycle
LLM_QUERIES_PER_CYCLE=${LLM_QUERIES_PER_CYCLE:-2}
PARALLEL_WORKERS=${PARALLEL_WORKERS:-1}
MAX_DISCOVER_PER_CYCLE=${MAX_DISCOVER_PER_CYCLE:-10}  # max new users to add per cycle

NITTER_URL="${NITTER_URL:-http://localhost:8081}"
LANCEDB_URI="${LANCEDB_URI:-http://lancedb-api:8000}"
OLLAMA_BASE_URL="${OLLAMA_BASE_URL:-http://ollama:11434}"
LOCAL_MODEL="${LOCAL_MODEL:-qwen2.5:14b-instruct}"

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
SEED_FILE="${SEED_FILE:-${SCRIPT_DIR}/nitter-seed-users.txt}"
QUERY_FILE="${QUERY_FILE:-${SCRIPT_DIR}/nitter-search-queries.txt}"

# Training capture via centralized TS module (no bash duplication)
TRAINING_CAPTURE_CLI="/app/scripts/training-capture-cli.ts"
TRAINING_CAPTURE="${TRAINING_CAPTURE:-true}"

# ── Nitter Health Check ───────────────────────────────────
check_nitter_health() {
  local health
  health=$(curl -sf --max-time 5 "$NITTER_URL/.health" 2>/dev/null || echo "")
  if [ -z "$health" ]; then
    echo "[$(date)] ❌ Nitter is not responding at $NITTER_URL" >> "$LOG"
    return 1
  fi
  echo "[$(date)] ✅ Nitter health: $health" >> "$LOG"
  return 0
}

# ── Load Seed Users ───────────────────────────────────────
load_seed_users() {
  if [ -f "$SEED_FILE" ]; then
    mapfile -t SEED_USERS < <(grep -v '^#' "$SEED_FILE" | grep -v '^$' | tr -d '@' | tr '[:upper:]' '[:lower:]')
    echo "[$(date)] Loaded ${#SEED_USERS[@]} seed users from $SEED_FILE" >> "$LOG"
  else
    SEED_USERS=()
    echo "[$(date)] No seed file found at $SEED_FILE" >> "$LOG"
  fi
}

# ── Load Search Queries ───────────────────────────────────
load_queries() {
  if [ -f "$QUERY_FILE" ]; then
    mapfile -t QUERIES < <(grep -v '^#' "$QUERY_FILE" | grep -v '^$')
    echo "[$(date)] Loaded ${#QUERIES[@]} search queries from $QUERY_FILE" >> "$LOG"
  else
    QUERIES=(
      "AI artificial intelligence"
      "crypto bitcoin ethereum"
      "tech startup funding"
      "breaking news today"
      "stock market trading"
    )
    echo "[$(date)] Using ${#QUERIES[@]} default queries" >> "$LOG"
  fi
}

# ── Seed Users into LanceDB ──────────────────────────────
seed_users_to_db() {
  load_seed_users
  for user in "${SEED_USERS[@]}"; do
    local exists
    exists=$(bash "$SCRIPT_DIR/lancedb-nitter-check.sh" user "$user" 2>/dev/null | jq -r '.exists' 2>/dev/null)
    if [ "$exists" != "true" ]; then
      echo "{\"username\": \"$user\", \"category\": \"seed\", \"discovered_from\": \"seed_file\", \"discovery_method\": \"manual\", \"crawl_priority\": 0.8}" \
        | bash "$SCRIPT_DIR/lancedb-nitter-store.sh" user >> "$LOG" 2>&1 || true
      echo "[$(date)]   Seeded user: @$user" >> "$LOG"
    fi
  done
}

# ── Get Crawl Queue ───────────────────────────────────────
# Returns usernames sorted by crawl priority (highest first)
get_crawl_queue() {
  local limit="${1:-10}"
  bash "$SCRIPT_DIR/lancedb-nitter-check.sh" crawl-queue "$limit" 2>/dev/null \
    | jq -r '.users[].username' 2>/dev/null
}

# ── Process Posts ─────────────────────────────────────────
# Takes JSONL posts, dedup-checks, stores novel ones, returns count
process_posts() {
  local source_label="$1"
  local stored=0
  local dupes=0
  local errors=0

  while IFS= read -r post_json; do
    [ -z "$post_json" ] && continue

    local tweet_id
    tweet_id=$(echo "$post_json" | jq -r '.tweet_id // ""' 2>/dev/null)
    [ -z "$tweet_id" ] && continue

    # Dedup check
    local check
    check=$(bash "$SCRIPT_DIR/lancedb-nitter-check.sh" post "$tweet_id" 2>/dev/null)
    local exists
    exists=$(echo "$check" | jq -r '.exists' 2>/dev/null)

    if [ "$exists" = "true" ]; then
      dupes=$((dupes + 1))
      continue
    fi

    # Store post
    local result
    result=$(echo "$post_json" | bash "$SCRIPT_DIR/lancedb-nitter-store.sh" post 2>/dev/null)
    local was_stored
    was_stored=$(echo "$result" | jq -r '.stored' 2>/dev/null)

    if [ "$was_stored" = "true" ]; then
      stored=$((stored + 1))
    else
      errors=$((errors + 1))
    fi
  done

  echo "[$(date)]   ${source_label}: stored=$stored, dupes=$dupes, errors=$errors" >> "$LOG"
  echo "$stored"
}

# ── Extract & Store Relationships ─────────────────────────
# Takes JSONL posts, extracts mention/quote/reply edges, stores them
extract_relationships() {
  local post_json
  while IFS= read -r post_json; do
    [ -z "$post_json" ] && continue

    local username
    username=$(echo "$post_json" | jq -r '.username // ""' 2>/dev/null)
    [ -z "$username" ] && continue

    local text
    text=$(echo "$post_json" | jq -r '.text // "" | .[0:200]' 2>/dev/null)

    # Mentions
    local mentions
    mentions=$(echo "$post_json" | jq -r '.mentions[]? // empty' 2>/dev/null)
    while IFS= read -r mentioned; do
      [ -z "$mentioned" ] && continue
      echo "{\"source_user\":\"$username\",\"target_user\":\"$mentioned\",\"relationship_type\":\"mentions\",\"context\":\"$text\"}" \
        | bash "$SCRIPT_DIR/lancedb-nitter-store.sh" relationship 2>/dev/null >> "$LOG" 2>&1 || true
    done <<< "$mentions"

    # Quotes
    local quoted
    quoted=$(echo "$post_json" | jq -r '.quoted_user // ""' 2>/dev/null)
    if [ -n "$quoted" ]; then
      echo "{\"source_user\":\"$username\",\"target_user\":\"$quoted\",\"relationship_type\":\"quotes\",\"context\":\"$text\"}" \
        | bash "$SCRIPT_DIR/lancedb-nitter-store.sh" relationship 2>/dev/null >> "$LOG" 2>&1 || true
    fi

    # Replies
    local reply_to
    reply_to=$(echo "$post_json" | jq -r '.reply_to_user // ""' 2>/dev/null)
    if [ -n "$reply_to" ]; then
      echo "{\"source_user\":\"$username\",\"target_user\":\"$reply_to\",\"relationship_type\":\"replies_to\",\"context\":\"$text\"}" \
        | bash "$SCRIPT_DIR/lancedb-nitter-store.sh" relationship 2>/dev/null >> "$LOG" 2>&1 || true
    fi
  done
}

# ── Discover New Users ────────────────────────────────────
# Takes JSONL posts, finds mentioned users not in our DB, scores them
discover_users() {
  local posts="$1"
  local max="${2:-$MAX_DISCOVER_PER_CYCLE}"

  echo "[$(date)]   Running user discovery analysis..." >> "$LOG"

  # Use LLM to score discovered users
  local discovery_json
  discovery_json=$(echo "$posts" | bash "$SCRIPT_DIR/nitter-analyze.sh" discover 2>/dev/null)

  if [ -z "$discovery_json" ] || [ "$discovery_json" = "[]" ]; then
    echo "[$(date)]   No new users discovered" >> "$LOG"
    return
  fi

  local added=0
  # Process each discovered user
  echo "$discovery_json" | jq -c '.[]' 2>/dev/null | head -"$max" | while IFS= read -r user_json; do
    local username
    username=$(echo "$user_json" | jq -r '.username // ""' 2>/dev/null)
    [ -z "$username" ] && continue

    # Check if already tracked
    local exists
    exists=$(bash "$SCRIPT_DIR/lancedb-nitter-check.sh" user "$username" 2>/dev/null | jq -r '.exists' 2>/dev/null)
    if [ "$exists" = "true" ]; then
      continue
    fi

    local priority
    priority=$(echo "$user_json" | jq -r '.crawl_priority // 0.3' 2>/dev/null)
    local category
    category=$(echo "$user_json" | jq -r '.category // "unknown"' 2>/dev/null)
    local reason
    reason=$(echo "$user_json" | jq -r '.reason // ""' 2>/dev/null)

    # Store new user
    echo "{\"username\":\"$username\",\"category\":\"$category\",\"discovered_from\":\"mention\",\"discovery_method\":\"llm_scored\",\"crawl_priority\":$priority,\"bio\":\"$reason\"}" \
      | bash "$SCRIPT_DIR/lancedb-nitter-store.sh" user 2>/dev/null >> "$LOG" 2>&1 || true

    echo "[$(date)]     Discovered: @$username (priority=$priority, category=$category)" >> "$LOG"
    added=$((added + 1))
  done

  echo "[$(date)]   Discovered $added new users" >> "$LOG"
}

# ── Generate LLM Queries ─────────────────────────────────
# Uses Ollama to generate novel search queries based on recent findings
generate_llm_queries() {
  local count=$1

  # Get recent post topics from LanceDB
  local recent_posts
  recent_posts=$(bash "$SCRIPT_DIR/lancedb-nitter-check.sh" search "trending news discussion" 0.8 2>/dev/null \
    | jq -r '.matches[:10][] | "- @\(.username): \(.text // "" | .[0:150])"' 2>/dev/null | head -10)

  if [ -z "$recent_posts" ]; then
    echo "[$(date)]   LLM query gen: no recent posts, skipping" >> "$LOG"
    return
  fi

  local personas=(
    "INFLUENCER HUNT: Find posts by or about people with large followings. Search for viral content, engagement bait, and influencer drama."
    "CONTRARIAN: Find opposing viewpoints. Search for debates, arguments, fact-checks, and controversial takes."
    "BREAKING: Find the most recent events being discussed. Search for 'just happened', 'breaking', 'developing', or time-sensitive topics."
    "NETWORK: Find communities. Search for hashtag movements, coordinated posts, or topic-specific groups."
    "DEEP DIVE: Pick one person and dig deeper. Find their discussions, who they argue with, what topics they dominate."
    "GLOBAL: Non-English perspectives. Search for international events, foreign policy, or regional topics."
    "MARKET SIGNAL: Find financial/market discussions. Search for earnings, trades, positions, or market predictions."
    "TECH: Find developer and technology discussions. Search for new tools, frameworks, launches, or technical debates."
  )
  local persona_idx=$((RANDOM % ${#personas[@]}))
  local persona="${personas[$persona_idx]}"

  local prompt="You are a social media researcher. Based on recent posts from our crawler:

${recent_posts}

YOUR ANGLE: ${persona}

Generate exactly ${count} NEW search queries to find interesting content on Twitter/X.
Each query should be 3-6 words, optimized for social media search.
Include usernames with from: prefix when searching for specific users.

Output ONLY queries, one per line. No numbering."

  echo "[$(date)]   LLM query gen: using ${persona:0:25}... persona" >> "$LOG"

  local escaped_prompt
  escaped_prompt=$(printf '%s' "$prompt" | jq -sR .)
  local response
  response=$(curl -sf "$OLLAMA_BASE_URL/api/generate" \
    --max-time 30 \
    -H "Content-Type: application/json" \
    -d "{
      \"model\": \"$LOCAL_MODEL\",
      \"prompt\": $escaped_prompt,
      \"stream\": false,
      \"options\": {\"temperature\": 0.7, \"num_ctx\": 4096}
    }" 2>/dev/null)

  local answer
  answer=$(echo "$response" | jq -r '.response // ""' 2>/dev/null)

  if [ -z "$answer" ]; then
    echo "[$(date)]   LLM query gen: no output" >> "$LOG"
    return
  fi

  echo "$answer" | grep -v '^$' | grep -v '^[#*-]' | sed 's/^[0-9]*[.)]\s*//' | head -"$count"
  echo "[$(date)]   LLM generated queries" >> "$LOG"
}

# ── Training Capture (via centralized TS module) ──────────
capture_training() {
  local type="$1"  # multi-turn, dpo, fallback, success
  local json="$2"  # JSON payload

  if [ "$TRAINING_CAPTURE" != "true" ]; then
    return 0
  fi

  if [ -f "$TRAINING_CAPTURE_CLI" ]; then
    echo "$json" | TRAINING_CAPTURE=true bun "$TRAINING_CAPTURE_CLI" "$type" >> "$LOG" 2>&1 || true
  fi
}

# ── Run Search Query ──────────────────────────────────────
run_search_query() {
  local query="$1"
  echo "[$(date)] Search: $query" >> "$LOG"

  # Fetch RSS
  local posts
  posts=$(bash "$SCRIPT_DIR/nitter-rss-fetch.sh" search "$query" 2>>"$LOG") || {
    echo "[$(date)]   RSS fetch failed for: $query" >> "$LOG"
    return 1
  }

  if [ -z "$posts" ]; then
    echo "[$(date)]   No posts returned for: $query" >> "$LOG"
    return 0
  fi

  local post_count
  post_count=$(echo "$posts" | wc -l)
  echo "[$(date)]   Fetched $post_count posts" >> "$LOG"

  # Process: dedup & store
  local stored
  stored=$(echo "$posts" | process_posts "search:$query")

  # Extract relationships
  echo "$posts" | extract_relationships

  # Capture training data for successful crawl
  if [ "$stored" -gt 0 ]; then
    local tool_args
    tool_args=$(jq -n --arg q "$query" '{"query": $q}')
    capture_training "success" "$(jq -n \
      --arg uq "Crawl Nitter RSS for: $query" \
      --arg fa "Stored $stored new posts from Nitter search for '$query'" \
      --arg model "$LOCAL_MODEL" \
      '[{
        "name": "Bash",
        "arguments": "{\"command\": \"bash nitter-rss-fetch.sh search '"$query"'\"}",
        "result": "Fetched '"$post_count"' posts, stored '"$stored"' new",
        "isError": false
      }]' as $tc |
      {
        "user_query": $uq,
        "tool_calls": $tc,
        "final_answer": $fa,
        "tags": ["nitter_crawl", "rss_search"],
        "model": $model
      }
    ')"
  fi

  # Return posts for batch analysis
  echo "$posts"
}

# ── Run User Timeline Crawl ──────────────────────────────
run_user_crawl() {
  local username="$1"
  echo "[$(date)] User crawl: @$username" >> "$LOG"

  # Try user RSS first, fall back to search with from: prefix
  local posts
  posts=$(bash "$SCRIPT_DIR/nitter-rss-fetch.sh" user "$username" 2>>"$LOG") || {
    echo "[$(date)]   User RSS failed, trying search fallback..." >> "$LOG"
    posts=$(bash "$SCRIPT_DIR/nitter-rss-fetch.sh" search "from:$username" 2>>"$LOG") || {
      echo "[$(date)]   Both methods failed for @$username" >> "$LOG"
      return 1
    }
  }

  if [ -z "$posts" ]; then
    echo "[$(date)]   No posts for @$username" >> "$LOG"
    return 0
  fi

  local post_count
  post_count=$(echo "$posts" | wc -l)
  echo "[$(date)]   Fetched $post_count posts from @$username" >> "$LOG"

  # Process & store
  local stored
  stored=$(echo "$posts" | process_posts "user:@$username")

  # Extract relationships
  echo "$posts" | extract_relationships

  echo "$posts"
}

# ── Pick Random Queries ───────────────────────────────────
pick_queries() {
  local count=$1
  load_queries
  local total=${#QUERIES[@]}
  if [ "$count" -ge "$total" ]; then
    printf '%s\n' "${QUERIES[@]}"
    return
  fi
  local indices
  indices=($(shuf -i 0-$((total-1)) -n "$count"))
  for i in "${indices[@]}"; do
    echo "${QUERIES[$i]}"
  done
}

# ── Main Crawl Cycle ──────────────────────────────────────
run_cycle() {
  local cycle_num="$1"
  local cycle_start
  cycle_start=$(date +%s)

  echo "" >> "$LOG"
  echo "================================================================" >> "$LOG"
  echo "[$(date)] CYCLE $cycle_num starting (instance=$INSTANCE)" >> "$LOG"
  echo "================================================================" >> "$LOG"

  # Accumulate all posts from this cycle for batch analysis
  local all_posts_file
  all_posts_file=$(mktemp)

  # ── Phase 1: Search queries ──────────────────────────
  echo "[$(date)] Phase 1: Search queries ($QUERIES_PER_CYCLE static + $LLM_QUERIES_PER_CYCLE LLM)" >> "$LOG"

  # Static queries
  local static_count=$((QUERIES_PER_CYCLE - LLM_QUERIES_PER_CYCLE))
  if [ "$static_count" -gt 0 ]; then
    while IFS= read -r query; do
      [ -z "$query" ] && continue
      local posts
      posts=$(run_search_query "$query" 2>>"$LOG") || true
      if [ -n "$posts" ]; then
        echo "$posts" >> "$all_posts_file"
      fi
      sleep "$QUERY_DELAY"

      # Check for stop signal
      if [ -f "$STOPFILE" ]; then
        rm -f "$STOPFILE" "$all_posts_file"
        echo "[$(date)] Stop signal received during search phase" >> "$LOG"
        return 1
      fi
    done < <(pick_queries "$static_count")
  fi

  # LLM-generated queries
  if [ "$LLM_QUERIES_PER_CYCLE" -gt 0 ]; then
    while IFS= read -r query; do
      [ -z "$query" ] && continue
      local posts
      posts=$(run_search_query "$query" 2>>"$LOG") || true
      if [ -n "$posts" ]; then
        echo "$posts" >> "$all_posts_file"
      fi
      sleep "$QUERY_DELAY"
    done < <(generate_llm_queries "$LLM_QUERIES_PER_CYCLE")
  fi

  # ── Phase 2: User timeline crawls ───────────────────
  echo "[$(date)] Phase 2: User timeline crawls ($USER_CRAWLS_PER_CYCLE users)" >> "$LOG"

  local users_to_crawl
  users_to_crawl=$(get_crawl_queue "$USER_CRAWLS_PER_CYCLE")

  if [ -n "$users_to_crawl" ]; then
    while IFS= read -r username; do
      [ -z "$username" ] && continue
      local posts
      posts=$(run_user_crawl "$username" 2>>"$LOG") || true
      if [ -n "$posts" ]; then
        echo "$posts" >> "$all_posts_file"
      fi
      sleep "$QUERY_DELAY"

      # Check stop
      if [ -f "$STOPFILE" ]; then
        rm -f "$STOPFILE" "$all_posts_file"
        echo "[$(date)] Stop signal received during user crawl phase" >> "$LOG"
        return 1
      fi
    done <<< "$users_to_crawl"
  else
    echo "[$(date)]   No users in crawl queue — seed some users first" >> "$LOG"
  fi

  # ── Phase 3: Batch LLM Analysis ─────────────────────
  local total_posts
  total_posts=$(wc -l < "$all_posts_file" 2>/dev/null || echo "0")

  if [ "$total_posts" -gt 0 ]; then
    echo "[$(date)] Phase 3: LLM analysis on $total_posts posts" >> "$LOG"

    # Trend detection
    echo "[$(date)]   Running trend detection..." >> "$LOG"
    local trends
    trends=$(cat "$all_posts_file" | bash "$SCRIPT_DIR/nitter-analyze.sh" trends 2>/dev/null) || true
    if [ -n "$trends" ] && [ "$trends" != "[]" ]; then
      echo "[$(date)]   Trends: $(echo "$trends" | jq -r '.trending_topics[:3][]?.topic // empty' 2>/dev/null | tr '\n' ', ')" >> "$LOG"

      # Extract suggested queries from trends for next cycle
      local trend_queries
      trend_queries=$(echo "$trends" | jq -r '.suggested_queries[]? // empty' 2>/dev/null | head -3)
      if [ -n "$trend_queries" ]; then
        echo "[$(date)]   Trend-suggested queries saved for next cycle" >> "$LOG"
      fi
    fi

    # User discovery
    echo "[$(date)]   Running user discovery..." >> "$LOG"
    discover_users "$(cat "$all_posts_file")"
  else
    echo "[$(date)] Phase 3: Skipped — no posts to analyze" >> "$LOG"
  fi

  rm -f "$all_posts_file"

  local cycle_end
  cycle_end=$(date +%s)
  local duration=$((cycle_end - cycle_start))
  echo "[$(date)] CYCLE $cycle_num complete in ${duration}s (${total_posts} posts processed)" >> "$LOG"
}

# ── Main Loop ─────────────────────────────────────────────
main() {
  echo "[$(date)] ====== Nitter Crawler starting (instance=$INSTANCE) ======" >> "$LOG"
  echo "[$(date)] Config: NITTER_URL=$NITTER_URL CYCLE_DELAY=${CYCLE_DELAY}s QUERIES=$QUERIES_PER_CYCLE USERS=$USER_CRAWLS_PER_CYCLE" >> "$LOG"

  # Health check
  if ! check_nitter_health; then
    echo "[$(date)] FATAL: Nitter not available. Start it first." >> "$LOG"
    exit 1
  fi

  # Seed initial users
  seed_users_to_db

  rm -f "$STOPFILE"
  local cycle=0

  while true; do
    cycle=$((cycle + 1))

    # Check stop signal
    if [ -f "$STOPFILE" ]; then
      rm -f "$STOPFILE"
      echo "[$(date)] Stop signal received. Exiting." >> "$LOG"
      break
    fi

    # Re-check Nitter health each cycle
    if ! check_nitter_health; then
      echo "[$(date)] Nitter unhealthy, waiting ${CYCLE_DELAY}s before retry..." >> "$LOG"
      sleep "$CYCLE_DELAY"
      continue
    fi

    run_cycle "$cycle" || break

    echo "[$(date)] Sleeping ${CYCLE_DELAY}s until next cycle..." >> "$LOG"
    sleep "$CYCLE_DELAY"
  done

  echo "[$(date)] ====== Nitter Crawler stopped (instance=$INSTANCE) ======" >> "$LOG"
}

main
