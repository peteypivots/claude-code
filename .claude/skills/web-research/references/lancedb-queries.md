# LanceDB Queries Reference

## Table: `research_findings`

### Schema

| Field | Type | Description |
|-------|------|-------------|
| `id` | string | UUID, primary key |
| `query` | string | Original query text |
| `canonical_query` | string | Normalized form (modifiers preserved) |
| `source_url` | string | Full URL of the source |
| `domain` | string | Extracted domain (e.g., "reuters.com") |
| `title` | string | Article/page title |
| `summary` | string | 2-3 sentence summary |
| `key_points` | string[] | Array of specific facts |
| `entities` | string[] | Normalized entity names |
| `tags` | string[] | Topic tags |
| `embedding` | vector(768) | nomic-embed-text embedding of summary |
| `timestamp` | string | ISO8601 datetime |
| `content_hash` | string | SHA256 of lowercase(title)+url+date |
| `source_rank` | float | Numeric score 0.0–1.0 |
| `source_tier` | string | official\|major_media\|specialized\|blog\|forum |

### REST API Patterns

Base URL: `$LANCEDB_URI` (default: `http://lancedb-api:8000`)
Database: `user_dbs`, Table: `research_findings`

**Important**: The query endpoint returns `.records`, the search endpoint returns `.results`.

#### Hash Dedup (Layer 1) — via `/query`

```bash
curl -s "$LANCEDB_URI/dbs/user_dbs/tables/research_findings/query" \
  -H "Content-Type: application/json" \
  -d '{
    "filter": "content_hash = '\''HASH_VALUE'\''",
    "limit": 1,
    "columns": ["id", "title", "source_url", "summary", "key_points", "timestamp"]
  }'
# Response: {"backend":"lancedb","db":"user_dbs","table":"research_findings","count":N,"records":[...]}
```

#### URL Dedup (Layer 2) — via `/query`

```bash
curl -s "$LANCEDB_URI/dbs/user_dbs/tables/research_findings/query" \
  -H "Content-Type: application/json" \
  -d '{
    "filter": "source_url = '\''https://example.com/article'\''",
    "limit": 1,
    "columns": ["id", "title", "summary", "key_points", "timestamp"]
  }'
# Response uses .records
```

#### Semantic Search (Layer 3) — via `/search`

```bash
# First embed query via Ollama (LanceDB's internal embed is misconfigured)
EMBEDDING=$(curl -s "$OLLAMA_BASE_URL/api/embed" \
  -H "Content-Type: application/json" \
  -d '{"model": "nomic-embed-text", "input": "your query"}' | jq '.embeddings[0]')

# Then vector search
curl -s "$LANCEDB_URI/dbs/user_dbs/tables/research_findings/search" \
  -H "Content-Type: application/json" \
  -d "{
    \"query_vector\": $EMBEDDING,
    \"top_k\": 5,
    \"columns\": [\"id\", \"title\", \"source_url\", \"summary\", \"key_points\", \"canonical_query\", \"timestamp\", \"source_rank\"]
  }"
# Response: {"backend":"lancedb","db":"user_dbs","table":"research_findings","count":N,"results":[...]}
# NOTE: search uses .results (not .records)
```

#### Hybrid Query (Semantic + Canonical)

```bash
# Vector search via /search (returns .results)
curl -s "$LANCEDB_URI/dbs/user_dbs/tables/research_findings/search" \
  -H "Content-Type: application/json" \
  -d "{\"query_vector\": $EMBEDDING, \"top_k\": 5}"

# Canonical query match via /query (returns .records)
curl -s "$LANCEDB_URI/dbs/user_dbs/tables/research_findings/query" \
  -H "Content-Type: application/json" \
  -d '{
    "filter": "canonical_query = '\''ai safety news'\''",
    "limit": 5
  }'

# Union results in the calling script (merge .results + .records)
```

#### Insert Finding — via `/ingest`

```bash
curl -s "$LANCEDB_URI/dbs/user_dbs/tables/research_findings/ingest" \
  -H "Content-Type: application/json" \
  -d '{"records": [{
    "id": "uuid-here",
    "query": "original query",
    "canonical_query": "ai safety news",
    "source_url": "https://...",
    "domain": "reuters.com",
    "title": "Article Title",
    "summary": "Summary text",
    "key_points": ["fact 1", "fact 2"],
    "entities": ["openai", "gpt-5"],
    "tags": ["ai", "safety"],
    "embedding": [0.1, 0.2, ...],
    "timestamp": "2026-04-02T14:30:00Z",
    "content_hash": "sha256hash",
    "source_rank": 0.9,
    "source_tier": "major_media"
  }], "mode": "append"}'
# Table auto-creates on first ingest
```

#### Freshness Filter

Add timestamp filter to any query:

```bash
"filter": "timestamp > '2026-04-01T14:30:00Z'"
```

#### Entity Lookup

```bash
curl -s "$LANCEDB_URI/dbs/user_dbs/tables/research_findings/query" \
  -H "Content-Type: application/json" \
  -d '{
    "filter": "array_contains(entities, '\''openai'\'')",
    "limit": 10
  }'
```

### jq Filtering Patterns

```bash
# For /query responses (uses .records)
jq '.records[] | {id, title, domain, source_rank, content_hash}'
jq '.records | length'

# For /search responses (uses .results)
jq '.results[] | select(._distance < 0.15)'
jq '.results[] | {id, title, domain, source_rank, content_hash, score: ._distance}'
jq '.results | length'

# Extract key_points
jq -r '.records[].key_points[]'   # from /query
jq -r '.results[].key_points[]'   # from /search
```

### Table Creation

If the table doesn't exist yet, create it with the first insert. LanceDB auto-creates tables on first write. Ensure the embedding dimension matches the model (nomic-embed-text = 768 dimensions).

### Embedding Generation

Use Ollama's embed endpoint:

```bash
curl -s "$OLLAMA_BASE_URL/api/embed" \
  -d '{
    "model": "nomic-embed-text",
    "input": "text to embed"
  }' | jq '.embeddings[0]'
```
