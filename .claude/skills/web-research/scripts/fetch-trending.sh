#!/bin/bash
# Fetch trending topics from various sources and convert to search queries
# Usage: ./fetch-trending.sh [count]
# Returns: one search query per line

set -euo pipefail

COUNT=${1:-5}
SEARXNG_URL="${SEARXNG_URL:-http://searxng:8080}"
CACHE_DIR="/tmp/trending-cache"
CACHE_TTL=1800  # 30 minutes
TMPDIR="/tmp/trending-$$"

mkdir -p "$CACHE_DIR" "$TMPDIR"
trap 'rm -rf "$TMPDIR"' EXIT

# Helper: cached fetch with TTL
cached_fetch() {
  local name="$1"
  local url="$2"
  local cache_file="$CACHE_DIR/${name}.json"
  
  # Check cache freshness
  if [ -f "$cache_file" ]; then
    local age=$(($(date +%s) - $(stat -c %Y "$cache_file" 2>/dev/null || echo 0)))
    if [ "$age" -lt "$CACHE_TTL" ]; then
      cat "$cache_file"
      return 0
    fi
  fi
  
  # Fetch fresh
  local result
  result=$(curl -sf --max-time 10 "$url" 2>/dev/null || echo "{}")
  echo "$result" > "$cache_file"
  echo "$result"
}

# === Source: Hacker News (front page titles) ===
fetch_hackernews() {
  local data
  data=$(cached_fetch "hn" "https://hacker-news.firebaseio.com/v0/topstories.json")
  
  # Get first 10 story IDs and fetch titles
  echo "$data" | jq -r '.[0:10] | .[]' 2>/dev/null | head -10 | while read -r id; do
    [ -n "$id" ] && curl -sf --max-time 5 "https://hacker-news.firebaseio.com/v0/item/${id}.json" 2>/dev/null | \
      jq -r '.title // empty' 2>/dev/null
  done
}

# === Source: Hacker News Jobs (jobstories API) ===
fetch_hn_jobs() {
  local data
  data=$(cached_fetch "hn_jobs" "https://hacker-news.firebaseio.com/v0/jobstories.json")
  
  # Get first 5 job story IDs and fetch titles
  echo "$data" | jq -r '.[0:5] | .[]' 2>/dev/null | head -5 | while read -r id; do
    [ -n "$id" ] && curl -sf --max-time 5 "https://hacker-news.firebaseio.com/v0/item/${id}.json" 2>/dev/null | \
      jq -r '.title // empty' 2>/dev/null
  done
}

# === Source: Y Combinator "Who is Hiring" thread (via Algolia API) ===
fetch_hn_who_is_hiring() {
  # Search for recent "Who is Hiring" thread comments to extract company/tech mentions
  local data
  data=$(curl -sf --max-time 10 "https://hn.algolia.com/api/v1/search_by_date?tags=story&query=who%20is%20hiring" 2>/dev/null)
  
  # Get the latest hiring thread ID
  local thread_id
  thread_id=$(echo "$data" | jq -r '.hits[0].objectID // empty' 2>/dev/null)
  
  if [ -n "$thread_id" ]; then
    # Fetch some comments from the thread to extract technologies/companies
    local comments
    comments=$(curl -sf --max-time 10 "https://hn.algolia.com/api/v1/search?tags=comment,story_${thread_id}&hitsPerPage=20" 2>/dev/null)
    
    # Extract company names and tech stacks mentioned (look for patterns like "Company | Location | Tech")
    echo "$comments" | jq -r '.hits[0:10] | .[].comment_text // empty' 2>/dev/null | \
      grep -oP '(?:hiring|looking for|seeking)\s+\K[A-Za-z0-9/+ ]+(?=\s+engineer|\s+developer)' 2>/dev/null | \
      head -3 | while read -r tech; do
        [ -n "$tech" ] && echo "$tech jobs hiring trends"
      done
  fi
}

# === Source: RemoteOK (tech remote jobs API) ===
fetch_remoteok_jobs() {
  local data
  data=$(cached_fetch "remoteok" "https://remoteok.com/api")
  
  # Extract job titles and tags (technologies)
  echo "$data" | jq -r '.[1:6] | .[] | .position + " " + (.tags | join(" "))' 2>/dev/null | \
    head -3 | while read -r job; do
      [ -n "$job" ] && echo "$job remote jobs market"
    done
}

# === Source: Indeed/LinkedIn trending job titles (via search) ===
fetch_job_trends() {
  # Use common job board URLs to find trending roles
  local searches=("AI engineer jobs" "Rust developer jobs" "DevOps platform engineer" "ML ops jobs" "LLM engineer")
  local idx=$((RANDOM % ${#searches[@]}))
  echo "${searches[$idx]} hiring trends 2026"
}

# === Source: GitHub Trending (via API) ===
fetch_github_trending() {
  # GitHub doesn't have a trending API, but we can search recent popular repos
  local data
  data=$(curl -sf --max-time 10 "https://api.github.com/search/repositories?q=created:>$(date -d '7 days ago' +%Y-%m-%d)&sort=stars&order=desc&per_page=5" 2>/dev/null)
  
  echo "$data" | jq -r '.items[0:5] | .[].full_name // empty' 2>/dev/null | \
    while read -r repo; do
      [ -n "$repo" ] && echo "$repo GitHub trending"
    done
}

# === Source: Crypto trending (CoinGecko trending) ===
fetch_crypto_trending() {
  local data
  data=$(cached_fetch "coingecko" "https://api.coingecko.com/api/v3/search/trending")
  
  echo "$data" | jq -r '.coins[0:3] | .[].item.name // empty' 2>/dev/null | \
    while read -r coin; do
      [ -n "$coin" ] && echo "$coin cryptocurrency news today"
    done
}

# === Source: Prediction Markets (Kalshi, Polymarket, PredictIt, etc.) ===
fetch_prediction_markets() {
  # Major prediction market platforms and topics
  local platforms=(
    "Kalshi prediction market"
    "Polymarket odds"
    "PredictIt contracts"
    "Metaculus forecasts"
    "Manifold Markets"
  )
  
  # Hot prediction market categories
  local categories=(
    "election prediction market odds"
    "Fed rate decision prediction market"
    "recession probability prediction market"
    "Trump Biden prediction market odds"
    "inflation prediction market Kalshi"
    "GDP forecast prediction market"
    "unemployment rate prediction market"
    "stock market prediction contracts"
    "crypto prediction market prices"
    "weather prediction market contracts"
    "AI prediction market timelines"
    "geopolitical event prediction markets"
    "sports championship prediction market"
    "Oscar Emmy prediction market odds"
    "Supreme Court prediction market"
    "IPO prediction market odds"
  )
  
  # Output platform query and category query
  echo "${platforms[$((RANDOM % ${#platforms[@]}))]}"
  echo "${categories[$((RANDOM % ${#categories[@]}))]}"
}

# === Source: Kalshi Specific (regulated US prediction market) ===
fetch_kalshi() {
  # Kalshi is CFTC-regulated, trades on real events
  local markets=(
    "Kalshi Fed funds rate contracts"
    "Kalshi inflation CPI contracts"
    "Kalshi recession probability"
    "Kalshi election contracts 2026"
    "Kalshi GDP growth contracts"
    "Kalshi unemployment rate"
    "Kalshi housing prices"
    "Kalshi climate weather contracts"
    "Kalshi tech earnings contracts"
    "Kalshi government shutdown odds"
    "Kalshi debt ceiling contracts"
    "Kalshi interest rate hike probability"
  )
  echo "${markets[$((RANDOM % ${#markets[@]}))]}"
}

# === Source: Product Hunt (via unofficial feed) ===
fetch_producthunt() {
  # Product Hunt RSS converted to JSON-ish extraction
  local data
  data=$(curl -sf --max-time 10 "https://www.producthunt.com/feed" 2>/dev/null | \
    grep -oP '(?<=<title>).*?(?=</title>)' | head -5)
  
  echo "$data" | while read -r title; do
    [ -n "$title" ] && [ "$title" != "Product Hunt" ] && echo "$title"
  done
}

# === Source: NewsAPI top headlines (free tier, limited) ===
fetch_newsapi() {
  # This requires API key, skip if not set
  local api_key="${NEWSAPI_KEY:-}"
  if [ -z "$api_key" ]; then
    return
  fi
  local data
  data=$(curl -sf --max-time 10 "https://newsapi.org/v2/top-headlines?country=us&apiKey=${api_key}" 2>/dev/null)
  
  echo "$data" | jq -r '.articles[0:5] | .[].title // empty' 2>/dev/null
}

# === Source: DuckDuckGo instant answers (topics) ===
fetch_duckduckgo_topics() {
  local query="trending news today"
  local encoded=$(echo "$query" | sed 's/ /+/g')
  local data
  data=$(curl -sf --max-time 10 "https://api.duckduckgo.com/?q=${encoded}&format=json" 2>/dev/null)
  
  echo "$data" | jq -r '.RelatedTopics[0:5] | .[].Text // empty' 2>/dev/null | \
    sed 's/ - .*$//' | head -3
}

# === Source: Horse Racing (UK/US racecards) ===
fetch_horse_racing() {
  # Rotate between UK and US racing queries
  local tracks=("Ascot" "Cheltenham" "Newmarket" "Churchill Downs" "Santa Anita" "Saratoga" "Del Mar" "Keeneland" "Gulfstream Park" "Belmont Park" "Aqueduct" "Oaklawn Park" "Pimlico" "Monmouth Park")
  local types=("tips" "form guide" "predictions" "results" "entries" "picks" "handicapping")
  local track="${tracks[$((RANDOM % ${#tracks[@]}))]}"
  local type="${types[$((RANDOM % ${#types[@]}))]}"
  echo "$track horse racing $type today"
  
  # Also try racing news
  local news=("Racing Post tips today" "Timeform horse racing analysis" "At The Races naps" "TVG picks today" "DRF daily racing form picks" "Equibase entries results")
  echo "${news[$((RANDOM % ${#news[@]}))]}"
}

# === Source: NYRA (New York Racing Association) ===
fetch_nyra() {
  # NYRA tracks: Saratoga, Belmont Park, Aqueduct
  local tracks=("Saratoga" "Belmont Park" "Aqueduct")
  local queries=(
    "NYRA bets picks today"
    "NYRA entries scratches today"
    "Saratoga race results today"
    "Belmont Park thoroughbred racing today"
    "Aqueduct horse racing picks"
    "NYRA stakes races schedule"
    "New York horse racing expert picks"
  )
  echo "${queries[$((RANDOM % ${#queries[@]}))]}"
}

# === Source: Thoroughbred Racing (Major events & data) ===
fetch_thoroughbred() {
  local events=(
    "Kentucky Derby contenders odds"
    "Preakness Stakes entries"
    "Belmont Stakes predictions"
    "Breeders Cup races odds"
    "Triple Crown horse racing"
    "Grade 1 stakes races today"
    "thoroughbred racing bloodlines pedigree"
  )
  local data=(
    "thoroughbred horse racing entries today"
    "thoroughbred speed figures Beyer"
    "Ragozin sheets thoroughbred"
    "Thoro-Graph pace figures"
    "thoroughbred workout reports"
    "thoroughbred claiming races today"
    "maiden special weight races today"
    "allowance optional claiming today"
  )
  # Output one event and one data query
  echo "${events[$((RANDOM % ${#events[@]}))]}"
  echo "${data[$((RANDOM % ${#data[@]}))]}"
}

# === Source: Japanese Boat Racing (Kyotei) ===
fetch_kyotei() {
  # Japanese powerboat racing - 24 venues across Japan
  local venues=("住之江" "戸田" "桐生" "平和島" "多摩川" "浜名湖" "蒲郡" "常滑" "津" "三国" "びわこ" "尼崎")
  local queries=(
    "kyotei boat race results today"
    "競艇 予想 本日"
    "boatrace.jp race schedule"
    "kyotei betting odds SG race"
    "Japanese powerboat racing live"
  )
  echo "${queries[$((RANDOM % ${#queries[@]}))]}"
}

# === Source: Keirin (Japanese Bicycle Racing) ===
fetch_keirin() {
  local queries=(
    "keirin bicycle racing results today"
    "競輪 予想 本日"
    "keirin.jp race schedule"
    "Japan keirin betting odds GP"
    "keirin track cycling predictions"
  )
  echo "${queries[$((RANDOM % ${#queries[@]}))]}"
}

# === Source: Sports Betting Lines (US Sports) ===
fetch_sports_betting() {
  local sports=("NFL" "NBA" "MLB" "NHL" "college football" "college basketball" "UFC" "boxing")
  local types=("betting lines" "spread picks" "over under totals" "moneyline odds" "prop bets" "parlays")
  local sport="${sports[$((RANDOM % ${#sports[@]}))]}"
  local type="${types[$((RANDOM % ${#types[@]}))]}"
  echo "$sport $type today"
  
  # Also include injury/news affecting lines
  local meta=("injury report" "lineup news" "weather impact" "sharp money" "public betting")
  echo "$sport ${meta[$((RANDOM % ${#meta[@]}))]} today"
}

# === Source: Global Racing (Harness, Greyhounds, Auto) ===
fetch_global_racing() {
  local queries=(
    "harness racing trotting results today"
    "greyhound racing tips UK"
    "NASCAR race results today"
    "Formula 1 qualifying results"
    "Australian horse racing Melbourne Cup"
    "Hong Kong racing HKJC tips"
    "Dubai World Cup racing"
    "Japan Racing JRA results"
  )
  echo "${queries[$((RANDOM % ${#queries[@]}))]}"
}

# === Main: fetch from all sources sequentially (more reliable than parallel subshells) ===
main() {
  echo "Fetching trending topics..." >&2
  
  # Hacker News - most reliable
  echo "  HN..." >&2
  fetch_hackernews > "$TMPDIR/hn.txt" 2>/dev/null &
  
  # Crypto
  echo "  Crypto..." >&2
  fetch_crypto_trending > "$TMPDIR/crypto.txt" 2>/dev/null &
  
  # Prediction Markets
  echo "  Prediction Markets..." >&2
  fetch_prediction_markets > "$TMPDIR/prediction_markets.txt" 2>/dev/null &
  
  # Kalshi (regulated prediction market)
  echo "  Kalshi..." >&2
  fetch_kalshi > "$TMPDIR/kalshi.txt" 2>/dev/null &
  
  # GitHub
  echo "  GitHub..." >&2
  fetch_github_trending > "$TMPDIR/github.txt" 2>/dev/null &
  
  # Product Hunt
  echo "  PH..." >&2
  fetch_producthunt > "$TMPDIR/ph.txt" 2>/dev/null &
  
  # HN Jobs API
  echo "  HN Jobs..." >&2
  fetch_hn_jobs > "$TMPDIR/hn_jobs.txt" 2>/dev/null &
  
  # RemoteOK Jobs
  echo "  RemoteOK..." >&2
  fetch_remoteok_jobs > "$TMPDIR/remoteok.txt" 2>/dev/null &
  
  # Job market trends (random popular role)
  echo "  Job trends..." >&2
  fetch_job_trends > "$TMPDIR/job_trends.txt" 2>/dev/null &
  
  # Horse Racing
  echo "  Horse Racing..." >&2
  fetch_horse_racing > "$TMPDIR/horse_racing.txt" 2>/dev/null &
  
  # NYRA (New York Racing Association)
  echo "  NYRA..." >&2
  fetch_nyra > "$TMPDIR/nyra.txt" 2>/dev/null &
  
  # Thoroughbred Racing
  echo "  Thoroughbred..." >&2
  fetch_thoroughbred > "$TMPDIR/thoroughbred.txt" 2>/dev/null &
  
  # Japanese Boat Racing (Kyotei)
  echo "  Kyotei..." >&2
  fetch_kyotei > "$TMPDIR/kyotei.txt" 2>/dev/null &
  
  # Keirin Bicycle Racing
  echo "  Keirin..." >&2
  fetch_keirin > "$TMPDIR/keirin.txt" 2>/dev/null &
  
  # Sports Betting
  echo "  Sports Betting..." >&2
  fetch_sports_betting > "$TMPDIR/sports_betting.txt" 2>/dev/null &
  
  # Global Racing
  echo "  Global Racing..." >&2
  fetch_global_racing > "$TMPDIR/global_racing.txt" 2>/dev/null &
  
  # Wait for all
  wait
  
  # Combine and dedupe
  cat "$TMPDIR"/*.txt 2>/dev/null | \
    grep -v '^$' | \
    sort -u | \
    shuf | \
    head -"$COUNT"
}

main "$@"
