#!/bin/bash
# nitter-analyze.sh — LLM-driven analysis of nitter posts
#
# Reads JSONL posts from stdin (output of nitter-rss-fetch.sh) and uses
# Ollama to extract entities, categorize users, detect trends, and
# score users for discovery priority.
#
# Usage:
#   cat posts.jsonl | nitter-analyze.sh entities      # extract entities & topics
#   cat posts.jsonl | nitter-analyze.sh categorize    # categorize mentioned users
#   cat posts.jsonl | nitter-analyze.sh trends        # detect trending topics
#   cat posts.jsonl | nitter-analyze.sh discover      # score new users for crawling
#
# Output: JSON results to stdout
#
# Environment:
#   LOCAL_MODEL       — Ollama model (default: qwen2.5:14b-instruct)
#   OLLAMA_BASE_URL   — Ollama endpoint (default: http://ollama:11434)

set -euo pipefail

COMMAND="${1:?Usage: nitter-analyze.sh <entities|categorize|trends|discover>}"

LOCAL_MODEL="${LOCAL_MODEL:-qwen2.5:14b-instruct}"
OLLAMA_BASE_URL="${OLLAMA_BASE_URL:-http://ollama:11434}"

# Read all JSONL from stdin
POSTS=$(cat)
if [ -z "$POSTS" ]; then
  echo '{"error": "No JSONL input on stdin"}'
  exit 1
fi

POST_COUNT=$(echo "$POSTS" | wc -l)

# Build a text summary of posts for the LLM (truncate to fit context)
build_post_summary() {
  local max_posts="${1:-30}"
  echo "$POSTS" | head -"$max_posts" | jq -r '
    "@\(.username): \(.text // .html_description | .[0:280])"
    + (if .mentions | length > 0 then " [mentions: " + (.mentions | join(", ")) + "]" else "" end)
    + (if .hashtags | length > 0 then " [tags: " + (.hashtags | join(", ")) + "]" else "" end)
    + (if .quoted_user != "" then " [quotes: @" + .quoted_user + "]" else "" end)
    + (if .reply_to_user != "" then " [reply to: @" + .reply_to_user + "]" else "" end)
  ' 2>/dev/null
}

# Call Ollama API directly (not via cli.mjs — faster for analysis)
ollama_generate() {
  local prompt="$1"
  local escaped_prompt
  escaped_prompt=$(printf '%s' "$prompt" | jq -sR .)

  local response
  response=$(curl -sf "$OLLAMA_BASE_URL/api/generate" \
    --max-time 60 \
    -H "Content-Type: application/json" \
    -d "{
      \"model\": \"$LOCAL_MODEL\",
      \"prompt\": $escaped_prompt,
      \"stream\": false,
      \"options\": {\"temperature\": 0.1, \"num_ctx\": 8192}
    }" 2>/dev/null)

  echo "$response" | jq -r '.response // ""' 2>/dev/null
}

# Extract JSON from LLM response (handles markdown fences, prose wrapping)
extract_json() {
  local text="$1"
  # Try raw JSON first
  if echo "$text" | jq -e . >/dev/null 2>&1; then
    echo "$text"
    return
  fi
  # Try markdown-fenced JSON
  local fenced
  fenced=$(echo "$text" | sed -n '/```json/,/```/p' | sed '1d;$d')
  if [ -n "$fenced" ] && echo "$fenced" | jq -e . >/dev/null 2>&1; then
    echo "$fenced"
    return
  fi
  # Try first { to last }
  local braced
  braced=$(echo "$text" | sed -n '/\[/{:a;N;/\]$/!ba;p;q}' 2>/dev/null)
  if [ -z "$braced" ]; then
    braced=$(echo "$text" | sed -n '/{/{:a;N;/}$/!ba;p;q}' 2>/dev/null)
  fi
  if [ -n "$braced" ] && echo "$braced" | jq -e . >/dev/null 2>&1; then
    echo "$braced"
    return
  fi
  # Fallback: return empty
  echo '[]'
}

# ── Entity Extraction ──────────────────────────────────────
analyze_entities() {
  local summary
  summary=$(build_post_summary 30)

  local prompt="Analyze these social media posts and extract structured information.

POSTS:
${summary}

Extract a JSON array of objects, one per post. Each object should have:
- username: the poster's handle
- entities: array of named entities (people, companies, products, events)
- key_topics: array of 1-3 topic categories (e.g., \"AI\", \"crypto\", \"politics\")
- sentiment: \"positive\", \"negative\", \"neutral\", or \"mixed\"

Output ONLY a JSON array. No explanation."

  local response
  response=$(ollama_generate "$prompt")
  local json
  json=$(extract_json "$response")

  # Merge back with original post data
  echo "$json"
}

# ── User Categorization ───────────────────────────────────
analyze_categorize() {
  # Collect unique usernames from posts + mentions
  local all_users
  all_users=$(echo "$POSTS" | jq -r '
    [.username] + (.mentions // []) + (if .quoted_user != "" then [.quoted_user] else [] end) + (if .reply_to_user != "" then [.reply_to_user] else [] end)
    | .[]
  ' | sort -u | head -50)

  # Build context: what each user posted / was mentioned in
  local user_context=""
  while IFS= read -r user; do
    [ -z "$user" ] && continue
    local user_posts
    user_posts=$(echo "$POSTS" | jq -r "select(.username == \"$user\") | .text // .html_description | .[0:200]" 2>/dev/null | head -3)
    local mentioned_in
    mentioned_in=$(echo "$POSTS" | jq -r "select(.mentions[]? == \"$user\" or .quoted_user == \"$user\" or .reply_to_user == \"$user\") | \"@\\(.username): \\(.text // \"\" | .[0:150])\"" 2>/dev/null | head -3)
    user_context="${user_context}
@${user}:
  Posts: ${user_posts:-none found}
  Mentioned in: ${mentioned_in:-none}"
  done <<< "$all_users"

  local prompt="Categorize these social media users based on their posts and how they're mentioned.

${user_context}

For each user, output a JSON array of objects with:
- username: the handle (lowercase)
- category: one of: influencer, news_outlet, analyst, trader, developer, company, bot, unknown
- description: 1-sentence summary of what they do/post about
- relevance: 0.0-1.0 score of how interesting they are to follow

Output ONLY a JSON array. No explanation."

  local response
  response=$(ollama_generate "$prompt")
  extract_json "$response"
}

# ── Trend Detection ────────────────────────────────────────
analyze_trends() {
  local summary
  summary=$(build_post_summary 40)

  local prompt="Analyze these social media posts for emerging trends and sentiment shifts.

POSTS (${POST_COUNT} total, showing up to 40):
${summary}

Identify:
1. Trending topics: subjects mentioned by multiple users or generating discussion
2. Sentiment shifts: topics where opinion is changing or polarized
3. Breaking signals: new information or events being discussed

Output a JSON object with:
{
  \"trending_topics\": [{\"topic\": \"...\", \"mentions\": N, \"sentiment\": \"...\", \"key_users\": [\"user1\", \"user2\"]}],
  \"sentiment_shifts\": [{\"topic\": \"...\", \"direction\": \"turning_positive|turning_negative|polarizing\", \"signal\": \"...\"}],
  \"breaking_signals\": [{\"event\": \"...\", \"source_users\": [\"...\"], \"confidence\": 0.0-1.0}],
  \"suggested_queries\": [\"query1\", \"query2\", \"query3\"]
}

Output ONLY JSON. No explanation."

  local response
  response=$(ollama_generate "$prompt")
  extract_json "$response"
}

# ── User Discovery Scoring ────────────────────────────────
analyze_discover() {
  # Count mention frequency per user
  local mention_counts
  mention_counts=$(echo "$POSTS" | jq -r '
    (.mentions // [])[] // empty,
    (if .quoted_user != "" then .quoted_user else empty end),
    (if .reply_to_user != "" then .reply_to_user else empty end)
  ' | sort | uniq -c | sort -rn | head -30)

  if [ -z "$mention_counts" ]; then
    echo '{"discovered_users": [], "reason": "no_mentions_found"}'
    return 0
  fi

  # Build user mention summary for LLM
  local user_summary=""
  while read -r count user; do
    [ -z "$user" ] && continue
    local contexts
    contexts=$(echo "$POSTS" | jq -r "select(.mentions[]? == \"$user\" or .quoted_user == \"$user\" or .reply_to_user == \"$user\") | \"  - @\\(.username): \\(.text // \"\" | .[0:120])\"" 2>/dev/null | head -3)
    user_summary="${user_summary}
@${user} (mentioned ${count}x):
${contexts}"
  done <<< "$mention_counts"

  local prompt="Score these discovered social media users for crawl priority.

Context: We're building a social graph crawler. We want to find interesting, active users
who would provide valuable data. Score each user based on their apparent importance,
activity level, and topical relevance.

DISCOVERED USERS (by mention frequency):
${user_summary}

For each user, output a JSON array with:
- username: the handle (lowercase)
- crawl_priority: 0.0-1.0 (higher = more interesting to crawl)
- category: influencer|news_outlet|analyst|trader|developer|company|bot|unknown
- reason: why this priority (1 sentence)
- suggested_queries: 1-2 search queries to find more about them

Output ONLY a JSON array. No explanation."

  local response
  response=$(ollama_generate "$prompt")
  local json
  json=$(extract_json "$response")

  # Enrich with mention counts
  echo "$json" | jq --arg mc "$mention_counts" '
    . as $users |
    ($mc | split("\n") | map(select(length > 0) | capture("\\s*(?<count>\\d+)\\s+(?<user>.+)")) | map({(.user): (.count | tonumber)}) | add // {}) as $counts |
    [$users[] | . + {mention_count: ($counts[.username] // 0)}]
  ' 2>/dev/null || echo "$json"
}

# ── Dispatch ───────────────────────────────────────────────
case "$COMMAND" in
  entities)    analyze_entities ;;
  categorize)  analyze_categorize ;;
  trends)      analyze_trends ;;
  discover)    analyze_discover ;;
  *)
    echo "{\"error\": \"Unknown command: $COMMAND. Use: entities, categorize, trends, discover\"}"
    exit 1
    ;;
esac
