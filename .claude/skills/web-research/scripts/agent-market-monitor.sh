#!/bin/bash
# Agent-driven market monitor — uses the LLM agent for each research query
#
# Run multiple instances with different INSTANCE names:
#   INSTANCE=sports ./agent-market-monitor.sh
#   INSTANCE=markets ./agent-market-monitor.sh
#
# Enable parallel workers (N concurrent agent invocations per batch):
#   PARALLEL_WORKERS=3 ./agent-market-monitor.sh
#
# Use orchestrator mode (spawns proper subagents via AgentTool):
#   ORCHESTRATOR_MODE=1 ./agent-market-monitor.sh
#
# Combine both for maximum throughput:
#   INSTANCE=sports PARALLEL_WORKERS=2 ./agent-market-monitor.sh &
#   INSTANCE=markets PARALLEL_WORKERS=2 ./agent-market-monitor.sh &
#
# Stop: touch /tmp/agent-monitor-${INSTANCE:-default}-stop
# Logs: /tmp/agent-monitor-${INSTANCE:-default}.log

set -euo pipefail

# Instance name for running multiple monitors in parallel
INSTANCE="${INSTANCE:-default}"
LOCKFILE="/tmp/agent-monitor-${INSTANCE}.lock"
PIDFILE="/tmp/agent-monitor-${INSTANCE}.pid"
STOPFILE="/tmp/agent-monitor-${INSTANCE}-stop"
LOG="/tmp/agent-monitor-${INSTANCE}.log"

# Prevent duplicate instances via flock
exec 9>"$LOCKFILE"
if ! flock -n 9; then
  echo "Monitor '$INSTANCE' already running (PID $(cat "$PIDFILE" 2>/dev/null || echo '?')). Exiting."
  exit 1
fi
echo $$ > "$PIDFILE"
trap 'rm -f "$PIDFILE"' EXIT

CYCLE_DELAY=${CYCLE_DELAY:-300}  # 5 min between cycles
QUERY_DELAY=${QUERY_DELAY:-10}   # 10s between queries (let model cool down)
QUERIES_PER_CYCLE=${QUERIES_PER_CYCLE:-8}
QUERY_FILE="${QUERY_FILE:-/app/.claude/skills/web-research/scripts/monitor-queries.txt}"

# Parallel workers — set > 1 to run multiple queries simultaneously
# Each worker is a separate agent invocation; distributes queries round-robin
# WARNING: High values may overwhelm Ollama; recommended 2-4 for local models
PARALLEL_WORKERS=${PARALLEL_WORKERS:-1}

# Orchestrator mode — uses the research-batch-orchestrator agent to spawn
# proper Claude Code subagents via AgentTool. This is the cleanest approach
# for parallel research as it uses the native agent spawning mechanism.
# Set ORCHESTRATOR_MODE=1 to enable. Overrides PARALLEL_WORKERS.
ORCHESTRATOR_MODE=${ORCHESTRATOR_MODE:-0}

# Default queries embedded — used only if query file doesn't exist
DEFAULT_QUERIES=(
  # === Markets ===
  "US stock market today S&P 500 Dow NASDAQ"
  "bond yields treasury 10Y 2Y curve"
  "VIX volatility index options market"
  "IPO market SPAC new listings 2026"
  "Wall Street earnings reports surprises"
  # === Macro ===
  "Federal Reserve interest rate FOMC decision"
  "inflation CPI PPI consumer prices"
  "GDP economic growth forecast recession"
  "unemployment jobs report nonfarm payrolls"
  "housing market home prices mortgage rates"
  # === Sectors ===
  "tech stocks NASDAQ mega-cap FAANG"
  "bank stocks financial sector stress"
  "energy oil prices OPEC crude"
  "gold silver commodities metals"
  "cryptocurrency bitcoin ethereum DeFi"
  # === Geopolitical ===
  "China trade tariffs supply chain"
  "geopolitical risk war sanctions markets"
  "US fiscal policy debt ceiling budget"
  # === News Sources ===
  "Drudge Report top headlines today"
  "ZeroHedge financial news today"
  "Reuters breaking financial news"
  "Bloomberg markets today"
  # === Specific Instruments ===
  "dollar index DXY forex currency"
  "crude oil WTI Brent natural gas"
  "copper lithium rare earth commodities"
  "commercial real estate office vacancy"
  "private equity venture capital deals"
  "corporate bond spreads credit market"
  "emerging markets EM currency crisis"
  "semiconductor chip stocks AI demand"
  "defense stocks military spending"
  "pharmaceutical biotech FDA approvals"
  "retail consumer spending e-commerce"
  "agricultural commodities wheat corn soybeans"
  "shipping freight rates global trade"
  "insurance industry catastrophe bonds"
  "SPDR sector ETF performance rotation"
  # === Prediction Markets ===
  "Kalshi prediction market Fed rate odds"
  "Polymarket election contracts odds"
  "PredictIt political markets"
  "Metaculus AI forecasts predictions"
  "recession probability prediction market"
  "inflation prediction market Kalshi contracts"
  # === Horse Racing ===
  "NYRA horse racing entries Saratoga Belmont Aqueduct"
  "thoroughbred racing results DRF picks today"
  "horse racing form guide tips today"
  "Churchill Downs Santa Anita racing entries"
  "Racing Post tips UK horse racing"
  "Equibase entries scratches results"
  "Kentucky Derby Preakness Belmont Stakes news"
  "Breeders Cup entries odds"
  # === Japanese Racing ===
  "kyotei boat race results boatrace.jp"
  "keirin bicycle racing results Japan"
  "JRA Japan Racing Association results"
  "競艇 予想 本日"
  "競輪 レース結果"
  # === Sports Betting ===
  "NFL betting lines spreads picks today"
  "NBA odds totals moneyline today"
  "MLB betting lines run totals"
  "UFC fight odds betting lines"
  "college football betting spreads"
  "sharp money sports betting trends"
  # === Global Racing ===
  "Hong Kong racing HKJC tips results"
  "Australian horse racing Melbourne Cup"
  "harness racing trotting results"
  "greyhound racing UK results"
)

# Load queries: prefer external file (hot-reloadable), fallback to defaults
load_queries() {
  if [ -f "$QUERY_FILE" ]; then
    mapfile -t QUERIES < <(grep -v '^#' "$QUERY_FILE" | grep -v '^$')
    echo "[$(date)] Loaded ${#QUERIES[@]} queries from $QUERY_FILE" >> "$LOG"
  else
    QUERIES=("${DEFAULT_QUERIES[@]}")
    echo "[$(date)] Using ${#QUERIES[@]} default queries" >> "$LOG"
  fi
}

# Time-aware query modifier — short contextual suffix
time_modifier() {
  local hour
  hour=$(date -u +%H)
  if [ "$hour" -lt 14 ]; then
    echo "today"
  elif [ "$hour" -lt 20 ]; then
    echo "today latest"
  else
    echo "today"
  fi
}

# Pick queries with category diversity — at least one from each category
pick_queries() {
  local count=$1
  local modifier
  modifier=$(time_modifier)

  # Reload queries each cycle (supports hot-reload of query file)
  load_queries

  local total=${#QUERIES[@]}
  if [ "$count" -ge "$total" ]; then
    # If asking for more than we have, use all
    for q in "${QUERIES[@]}"; do
      echo "${q} ${modifier}"
    done
    return
  fi

  # Shuffle and pick
  local indices
  indices=($(shuf -i 0-$((total-1)) -n "$count"))
  for i in "${indices[@]}"; do
    echo "${QUERIES[$i]} ${modifier}"
  done
}

RESEARCH_PROMPT="$(cat /app/.claude/prompts/research-system.md)"

# MCP config with meta-ai-mcp for web research
MCP_CONFIG_FILE="/tmp/meta-ai-mcp-config.json"
META_AI_MCP_URL="${META_AI_MCP_URL:-http://meta-ai-mcp:8099}"
cat > "$MCP_CONFIG_FILE" <<MCPEOF
{
  "mcpServers": {
    "meta-ai-mcp": {
      "type": "http",
      "url": "${META_AI_MCP_URL}/"
    }
  }
}
MCPEOF

# Nitter storage is now handled by TypeScript layer (src/services/llm/researchCapture.ts)
# MCP tool results flow through queryModelRouter → captureResearchFindings automatically

# Training data capture is now handled by TypeScript layer (src/services/llm/trainingCapture.ts)
# Configured via .env or docker-compose.yml

# Training capture functions removed - now handled by TypeScript layer
# Stub function for backward compatibility
capture_multi_turn_example() {
  # Stub - training capture now handled by TypeScript layer
  return 0
}

capture_dpo_pair() {
  # Stub - training capture now handled by TypeScript layer
  return 0
}

capture_training_example() {
  # Stub - training capture now handled by TypeScript layer
  return 0
}

# Number of LLM-generated queries per cycle (rest come from static list)
LLM_QUERIES_PER_CYCLE=${LLM_QUERIES_PER_CYCLE:-2}

# Number of trending queries per cycle (from fetch-trending.sh)
TRENDING_QUERIES_PER_CYCLE=${TRENDING_QUERIES_PER_CYCLE:-2}
TRENDING_SCRIPT="/app/.claude/skills/web-research/scripts/fetch-trending.sh"

# Fetch trending topics from various sources (HN, Reddit, TechMeme, etc.)
fetch_trending_queries() {
  local count=$1
  if [ ! -x "$TRENDING_SCRIPT" ]; then
    chmod +x "$TRENDING_SCRIPT" 2>/dev/null || true
  fi
  if [ -f "$TRENDING_SCRIPT" ]; then
    echo "[$(date)]   Fetching $count trending topics..." >> "$LOG"
    local topics
    topics=$(bash "$TRENDING_SCRIPT" "$count" 2>/dev/null || echo "")
    if [ -n "$topics" ]; then
      echo "$topics"
      echo "[$(date)]   Got $(echo "$topics" | wc -l) trending queries" >> "$LOG"
    else
      echo "[$(date)]   Trending fetch returned empty" >> "$LOG"
    fi
  else
    echo "[$(date)]   Trending script not found: $TRENDING_SCRIPT" >> "$LOG"
  fi
}

# Generate novel queries using the LLM based on recent LanceDB findings
generate_llm_queries() {
  local count=$1

  # Pull recent findings from LanceDB for context
  local recent
  recent=$(bash /app/.claude/skills/web-research/scripts/lancedb-check.sh "market economy finance" 2>/dev/null \
    | jq -r '.matches[:10] | .[] | "- \(.title // "untitled"): \(.summary // .content // "" | .[0:120])"' 2>/dev/null \
    | head -10)

  if [ -z "$recent" ]; then
    echo "[$(date)]   LLM query gen: no recent findings, skipping" >> "$LOG"
    return
  fi

  # Rotate between different research "personas" for query diversity
  local personas=(
    "CONTRARIAN: Find arguments AGAINST the consensus. What are bears saying? What risks are being ignored? Search for skeptics, short sellers, and critics."
    "DEEP DIVE: Pick ONE topic from the findings and go deeper. Find primary sources, expert opinions, historical precedents, or technical analysis."
    "CONNECTIONS: Find links between different themes. How does Topic A affect Topic B? Search for ripple effects, correlations, and second-order consequences."
    "PREDICTIONS: What happens next? Search for forecasts, prediction markets, analyst expectations, and expert outlooks on these topics."
    "ALTERNATIVE DATA: Find unconventional signals. Search for sentiment data, insider activity, supply chain indicators, or real-time data sources."
    "HISTORICAL: Find historical parallels. When did similar situations happen before? What were the outcomes? Search for 'reminds me of' or 'similar to'."
    "GLOBAL: How do other regions view this? Search for non-US perspectives, emerging market angles, or international implications."
    "RETAIL vs INSTITUTIONAL: What are retail traders saying vs hedge funds? Search for r/wallstreetbets, fintwit sentiment, or institutional flows."
    "BETTING MARKETS: What are prediction markets and betting odds saying? Search Kalshi, Polymarket, sports books, or futures markets for sentiment."
    "RACING FORM: For any sports/racing topics, search for expert handicapping analysis, speed figures, trainer/jockey stats, or track conditions."
  )
  local persona_idx=$((RANDOM % ${#personas[@]}))
  local persona="${personas[$persona_idx]}"

  # Ask the LLM to generate novel search queries
  local gen_prompt="You are a financial research assistant. Based on these recent findings from our database:

${recent}

YOUR RESEARCH ANGLE: ${persona}

Generate exactly ${count} NEW search queries that would find DIFFERENT and DEEPER information than what we already have.

Rules:
- Each query should be 4-8 words, optimized for web search
- Be SPECIFIC - use names, tickers, dates, or numbers when relevant
- Don't repeat topics we already have
- Include at least one prediction market or betting odds query if relevant

Output ONLY the queries, one per line. No numbering, no explanation."

  echo "[$(date)]   LLM query gen: using ${persona:0:20}... persona" >> "$LOG"

  local result
  result=$(LOCAL_SYSTEM_PROMPT="You output only search queries, one per line. No commentary." \
    LOCAL_MODEL="${LOCAL_MODEL:-qwen2.5:14b-instruct}" \
    bun /app/cli.mjs \
      --tools "" \
      --mcp-config "$MCP_CONFIG_FILE" \
      --dangerously-skip-permissions \
      --output-format json \
      -p "$gen_prompt" 2>/dev/null)

  local answer
  answer=$(echo "$result" | grep '^{"type":"result"' | tail -1 | jq -r '.result // ""' 2>/dev/null)

  if [ -z "$answer" ]; then
    echo "[$(date)]   LLM query gen: no output" >> "$LOG"
    return
  fi

  # Extract clean query lines (skip blank, skip lines with special chars)
  echo "$answer" | grep -v '^$' | grep -v '^[#*-]' | sed 's/^[0-9]*[.)]\s*//' | head -"$count"
  echo "[$(date)]   LLM generated ${count} queries from recent findings" >> "$LOG"
}

run_agent_query() {
  local query="$1"

  # Simple prompt: just ask Meta AI about the topic and return the answer
  # The bash script handles storage — the model doesn't need to run pipeline scripts
  local prompt="Use the meta_ai_chat tool to research: \"${query}\"

Return the full Meta AI response as your answer. Do NOT call any other tools. Do NOT try to store results. Just call meta_ai_chat and return what it says."

  echo "[$(date)] Agent query: $query" >> "$LOG"

  local result
  result=$(LOCAL_SYSTEM_PROMPT="You are a research assistant. Call the meta_ai_chat tool with the user's query, then return the response verbatim. Do not call Bash or any other tool." \
    LOCAL_MODEL="${LOCAL_MODEL:-qwen2.5:14b-instruct}" \
    timeout 120 bun /app/cli.mjs \
      --tools "" \
      --mcp-config "$MCP_CONFIG_FILE" \
      --dangerously-skip-permissions \
      --output-format json \
      -p "$prompt" 2>/dev/null) || true

  # Extract only the JSON line (last line starting with {)
  local json_line
  json_line=$(echo "$result" | grep '^{"type":"result"' | tail -1)
  local answer
  answer=$(echo "$json_line" | jq -r '.result // "no result"' 2>/dev/null || echo "parse error")
  local turns
  turns=$(echo "$json_line" | jq -r '.num_turns // 0' 2>/dev/null || echo "?")
  local duration
  duration=$(echo "$json_line" | jq -r '.duration_ms // 0' 2>/dev/null || echo "?")

  echo "[$(date)]   Turns: $turns | Duration: ${duration}ms" >> "$LOG"

  # Always store whatever the model returned via the pipeline script
  # (regardless of whether the model used tools or hallucinated)
  if [ -n "$answer" ] && [ "$answer" != "no result" ] && [ "$answer" != "parse error" ]; then
    local store_result
    store_result=$(bash /app/.claude/skills/web-research/scripts/meta-ai-pipeline.sh "$query" "$answer" 2>/dev/null || echo "store_error")
    local stored
    stored=$(echo "$store_result" | grep -c "STORED" || echo "0")
    local dupes
    dupes=$(echo "$store_result" | grep -c "DUPLICATE" || echo "0")
    echo "[$(date)]   Stored: $stored new, $dupes dupes | Answer: ${answer:0:150}" >> "$LOG"
  else
    echo "[$(date)]   ⚠️  No usable response: ${answer:0:100}" >> "$LOG"
  fi

  echo "---" >> "$LOG"
}

# Run a single query in a worker subprocess (for parallel execution)
# Args: query, worker_id, result_file
run_worker_query() {
  local query="$1"
  local worker_id="$2"
  local result_file="$3"

  # Simple prompt — model just calls meta_ai_chat, bash handles storage
  local prompt="Use the meta_ai_chat tool to research: \"${query}\"

Return the full Meta AI response as your answer. Do NOT call any other tools."

  local start_ms
  start_ms=$(date +%s%3N)

  local result
  result=$(LOCAL_SYSTEM_PROMPT="You are a research assistant. Call the meta_ai_chat tool with the user's query, then return the response verbatim. Do not call Bash or any other tool." \
    LOCAL_MODEL="${LOCAL_MODEL:-qwen2.5:14b-instruct}" \
    timeout 120 bun /app/cli.mjs \
      --tools "" \
      --mcp-config "$MCP_CONFIG_FILE" \
      --dangerously-skip-permissions \
      --output-format json \
      -p "$prompt" 2>/dev/null) || true

  local end_ms
  end_ms=$(date +%s%3N)
  local elapsed=$((end_ms - start_ms))

  # Extract JSON result
  local json_line
  json_line=$(echo "$result" | grep '^{"type":"result"' | tail -1)
  local answer
  answer=$(echo "$json_line" | jq -r '.result // "no result"' 2>/dev/null || echo "parse error")
  local turns
  turns=$(echo "$json_line" | jq -r '.num_turns // 0' 2>/dev/null || echo "?")

  # Always store the response via pipeline
  if [ -n "$answer" ] && [ "$answer" != "no result" ] && [ "$answer" != "parse error" ]; then
    local store_result
    store_result=$(bash /app/.claude/skills/web-research/scripts/meta-ai-pipeline.sh "$query" "$answer" 2>/dev/null || echo "store_error")
    local stored
    stored=$(echo "$store_result" | grep -c "STORED" || echo "0")
    local dupes
    dupes=$(echo "$store_result" | grep -c "DUPLICATE" || echo "0")
    
    answer="stored=$stored, dupes=$dupes"
  fi

  # Write result to file for main process to collect
  echo "W${worker_id}|${elapsed}ms|turns=${turns}|${query}|${answer:0:100}" >> "$result_file"
}

# Run queries in parallel across N workers
# Args: array of queries (passed by name), worker count
run_parallel_queries() {
  local -n queries_ref=$1
  local workers=$2
  local result_file="/tmp/agent-monitor-${INSTANCE}-results-$$.txt"
  rm -f "$result_file"
  touch "$result_file"

  local total=${#queries_ref[@]}
  echo "[$(date)] Parallel mode: distributing $total queries across $workers workers" >> "$LOG"

  # Track worker PIDs
  local pids=()

  # Distribute queries round-robin to workers
  for ((w=0; w<workers; w++)); do
    (
      for ((i=w; i<total; i+=workers)); do
        local q="${queries_ref[$i]}"
        if [ -n "$q" ]; then
          run_worker_query "$q" "$w" "$result_file"
        fi
      done
    ) &
    pids+=("$!")
    echo "[$(date)]   Started worker $w (PID: $!)" >> "$LOG"
  done

  # Wait for all workers to complete
  local failed=0
  for pid in "${pids[@]}"; do
    if ! wait "$pid"; then
      ((failed++))
    fi
  done

  # Collect results
  if [ -f "$result_file" ]; then
    local completed
    completed=$(wc -l < "$result_file")
    echo "[$(date)] Parallel batch complete: $completed/$total queries, $failed worker failures" >> "$LOG"
    while IFS= read -r line; do
      echo "[$(date)]   $line" >> "$LOG"
    done < "$result_file"
    rm -f "$result_file"
  fi
}

# Run queries via the research-batch-orchestrator agent
# This spawns proper Claude Code subagents via AgentTool for parallel research
run_orchestrator_batch() {
  local -n queries_ref=$1
  local total=${#queries_ref[@]}

  echo "[$(date)] Orchestrator mode: sending $total queries to batch orchestrator" >> "$LOG"

  # Build the query list as a prompt
  local query_list=""
  for q in "${queries_ref[@]}"; do
    if [ -n "$q" ]; then
      query_list="${query_list}
- ${q}"
    fi
  done

  local prompt="Research these topics in parallel, spawning one web-researcher worker per topic:
${query_list}

After all workers complete, report:
1. Total new findings stored
2. Brief summary of each topic's findings
3. Any failures or empty results"

  echo "[$(date)]   Launching orchestrator..." >> "$LOG"

  local start_ms
  start_ms=$(date +%s%3N)

  local result
  result=$(LOCAL_SYSTEM_PROMPT="You are a research batch orchestrator. Spawn web-researcher workers in parallel." \
    LOCAL_MODEL="${LOCAL_MODEL:-qwen2.5:14b-instruct}" \
    bun /app/cli.mjs \
      --agent research-batch-orchestrator \
      --tools "Agent,Bash,Read" \
      --mcp-config "$MCP_CONFIG_FILE" \
      --dangerously-skip-permissions \
      --output-format json \
      -p "$prompt" 2>/dev/null)

  local end_ms
  end_ms=$(date +%s%3N)
  local elapsed=$((end_ms - start_ms))

  # Extract JSON result
  local json_line
  json_line=$(echo "$result" | grep '^{"type":"result"' | tail -1)
  local answer
  answer=$(echo "$json_line" | jq -r '.result // "no result"' 2>/dev/null || echo "parse error")
  local turns
  turns=$(echo "$json_line" | jq -r '.num_turns // 0' 2>/dev/null || echo "?")

  echo "[$(date)]   Orchestrator complete: ${elapsed}ms, ${turns} turns" >> "$LOG"
  echo "[$(date)]   Result: ${answer:0:300}" >> "$LOG"
}

echo "=== Agent Market Monitor Started ===" >> "$LOG"
if [ "$ORCHESTRATOR_MODE" = "1" ]; then
  echo "[$(date)] Mode: ORCHESTRATOR (spawns subagents via AgentTool)" >> "$LOG"
elif [ "$PARALLEL_WORKERS" -gt 1 ]; then
  echo "[$(date)] Mode: PARALLEL_WORKERS=$PARALLEL_WORKERS (bash backgrounding)" >> "$LOG"
else
  echo "[$(date)] Mode: SEQUENTIAL" >> "$LOG"
fi
echo "[$(date)] Cycle delay: ${CYCLE_DELAY}s | Queries/cycle: ${QUERIES_PER_CYCLE}" >> "$LOG"

cycle=0
while true; do
  # Stop signal
  if [ -f "$STOPFILE" ]; then
    echo "[$(date)] Stop signal received. Exiting." >> "$LOG"
    rm -f "$STOPFILE"
    break
  fi

  cycle=$((cycle + 1))
  echo "[$(date)] === Cycle $cycle ===" >> "$LOG"

  # Static queries from file/defaults
  static_count=$((QUERIES_PER_CYCLE - LLM_QUERIES_PER_CYCLE - TRENDING_QUERIES_PER_CYCLE))
  if [ "$static_count" -lt 1 ]; then static_count=1; fi
  mapfile -t selected < <(pick_queries "$static_count")

  # Trending queries from external sources (HN, Reddit, TechMeme, etc.)
  if [ "$TRENDING_QUERIES_PER_CYCLE" -gt 0 ]; then
    echo "[$(date)] Fetching $TRENDING_QUERIES_PER_CYCLE trending queries..." >> "$LOG"
    mapfile -t trending_queries < <(fetch_trending_queries "$TRENDING_QUERIES_PER_CYCLE")
    for q in "${trending_queries[@]}"; do
      if [ -n "$q" ]; then
        selected+=("$q")
      fi
    done
  fi

  # LLM-generated queries (every cycle after first, to have some data)
  if [ "$cycle" -gt 1 ] && [ "$LLM_QUERIES_PER_CYCLE" -gt 0 ]; then
    echo "[$(date)] Generating $LLM_QUERIES_PER_CYCLE LLM queries from recent findings..." >> "$LOG"
    mapfile -t llm_queries < <(generate_llm_queries "$LLM_QUERIES_PER_CYCLE")
    for q in "${llm_queries[@]}"; do
      if [ -n "$q" ]; then
        selected+=("$q")
      fi
    done
  fi

  echo "[$(date)] Running ${#selected[@]} queries this cycle" >> "$LOG"

  if [ "$ORCHESTRATOR_MODE" = "1" ]; then
    # Orchestrator mode: use research-batch-orchestrator to spawn proper subagents
    run_orchestrator_batch selected
  elif [ "$PARALLEL_WORKERS" -gt 1 ]; then
    # Parallel mode: distribute across workers via bash backgrounding
    run_parallel_queries selected "$PARALLEL_WORKERS"
  else
    # Sequential mode (original behavior)
    for q in "${selected[@]}"; do
      # Check stop signal between queries
      if [ -f "$STOPFILE" ]; then
        echo "[$(date)] Stop signal received mid-cycle. Exiting." >> "$LOG"
        rm -f "$STOPFILE"
        exit 0
      fi

      run_agent_query "$q"
      sleep "$QUERY_DELAY"
    done
  fi

  echo "[$(date)] Cycle $cycle complete. Sleeping ${CYCLE_DELAY}s..." >> "$LOG"
  sleep "$CYCLE_DELAY"
done
