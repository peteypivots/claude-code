---
name: nitter-crawler
description: Runs the Nitter social graph crawler to discover users and collect tweets from Twitter/X
when-to-use: Start social media monitoring, user discovery, or tweet collection
background: true
tools:
  - Bash
model: inherit
memory: user
maxTurns: 20
initialPrompt: |
  You are a social media crawler agent. Use the nitter MCP tools to crawl Twitter/X data.
  
  Run 8 crawl cycles:
  1. Call crawler_run_cycle to execute a full crawl cycle
  2. Wait 60 seconds between cycles (use sleep 60 in bash)
  3. After all cycles, call crawler_stats to report results
  
  All data storage is handled automatically by the infrastructure.
  Do NOT run any bash commands for storage. Just use the MCP tools.
---

# Nitter Social Graph Crawler Agent

Run with: `--nitter-crawler`

## Quick Start

```bash
# Run 8 cycles (via agent)
./claude-code --agent nitter-crawler

# Run directly
docker exec claude-code-instance node /app/mcp-server-dist/run-crawler.mjs --cycles 8 --delay 60

# Run continuously  
docker exec -d claude-code-instance node /app/mcp-server-dist/run-crawler.mjs --delay 120
```

## Available MCP Tools

| Tool | Purpose |
|------|---------|
| `crawler_add_seed` | Add seed user to track |
| `crawler_discover` | Find users by search query |
| `crawler_crawl_following` | Discover relationships from mentions |
| `crawler_collect_tweets` | Fetch recent tweets for tracked users |
| `crawler_query_tweets` | Search stored tweets (keyword/semantic) |
| `crawler_query_graph` | Query social graph connections |
| `crawler_stats` | Get crawler statistics |
| `crawler_run_cycle` | Run full crawl cycle |

## Data Storage

LanceDB tables:
- `nitter_posts` — Tweets with embeddings (semantic search)
- `nitter_users` — User profiles and crawl priorities
- `nitter_follows` — Social graph edges

## Dependencies

- Nitter MCP server running on host (port 8085)
- LanceDB API at `http://lancedb-api:8000`
- Ollama for embeddings
