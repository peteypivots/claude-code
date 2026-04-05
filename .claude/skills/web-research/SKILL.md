---
name: web-research
description: 'Web research with LanceDB memory and 3-layer dedup. Use when: researching topics, investigating news, finding current events, exploring what happened, collecting information from the internet, web search and analysis, what is happening today.'
---

# Web Research with LanceDB Memory

## When to Use

- Research current events, news, or historical events
- Investigate a topic across multiple sources
- Collect and synthesize information from the web
- Any query requiring internet search and analysis

## 10-Step Research Pipeline

### Step 1: Decompose Query

Break the user's query into 3-5 targeted sub-questions that cover different angles.

Example: "What's happening in AI today?" →
- "major AI product launches today"
- "AI research papers published today"
- "AI company news and funding today"

### Step 2: Normalize Queries to Canonical Intent

For each sub-query, produce a canonical form for dedup matching:

1. Lowercase the entire query
2. Remove stopwords: today, latest, recent, current, breaking, the, a, an, is, are, was, were, what, how, about, in, on, for, just, now
3. Collapse synonyms: news/updates/developments → news, advances/breakthroughs/progress → advances, research/studies/papers → research
4. **Preserve top 1-2 modifiers** (do NOT over-collapse):
   - "AI safety news today" → `ai safety news` (keep "safety")
   - "AI funding updates" → `ai funding news` (keep "funding", collapse "updates")
   - "latest AI news" → `ai news` (no modifier to keep)
5. Sort remaining keywords alphabetically

### Step 3: 3-Layer Dedup Check (Cheapest First)

Run `.claude/skills/web-research/scripts/lancedb-check.sh` for each sub-query.

**Layer 1 — Content Hash (O(1), cheapest):**
Check if `content_hash` already exists in LanceDB.

**Layer 2 — URL Match (O(1)):**
Check if `source_url` already stored.

**Layer 3 — Semantic Vector Search (expensive, only if layers 1-2 miss):**
Vector similarity search, topK=5, threshold >0.85.
Also match `canonical_query == input` (hybrid retrieval).

**Decision:**
- If ANY layer matches → reuse stored finding, DO NOT fetch again
- Exception: freshness override (see Step 3b)

### Step 3b: Freshness Logic

If the query contains temporal keywords (`today`, `latest`, `current`, `breaking`, `just`, `now`):
- Ignore cached findings older than 24 hours
- **Fallback**: if no results within 24h → expand to 3-7 days, clearly label output as "recent (last N days)"

If the query includes a specific date/year → filter to that time range.

Otherwise → use all cached findings regardless of age.

### Step 4: WebSearch — Discovery

Use WebSearch tool with each sub-query. Target 5-10 results per sub-query.

Use `allowed_domains` when the user requests specific sources or when quality filtering is needed.

### Step 5: Filter and Rank Sources

Score each result using numeric ranking:

| Tier | Score | Examples |
|------|-------|----------|
| official | 1.0 | .gov, .edu, company press releases |
| major_media | 0.9 | Reuters, AP, NYT, BBC, Ars Technica, The Verge, Wired |
| specialized | 0.8 | Domain-specific technical publications |
| blog | 0.6 | Personal/company blogs |
| forum | 0.4 | Reddit, HN (sentiment only, not facts) |
| seo_farm | 0.0 | SEO farms, aggregators, content mills — SKIP |

**Final source score:**
```
score = relevance * source_rank * recency_weight
```

Recency weight: 1.0 (<24h), 0.9 (<7d), 0.7 (<30d), 0.5 (older)

**Avoid:**
- SEO farms and content aggregators
- Domains that duplicate content from primary sources
- Paywalled articles where only the headline is visible

### Step 6: WebFetch — Top Sources Only

Fetch ONLY the top 2-3 highest-scored sources. Never fetch more than 3 per sub-query.

Use the `prompt` parameter to focus extraction:
```
"Extract key facts, dates, names, numbers, and direct quotes. Identify the publish date."
```

### Step 7: Extract Structured Findings

For each fetched article, produce a structured finding in this exact JSON format:

```json
{
  "id": "",
  "query": "original sub-query text",
  "canonical_query": "normalized canonical form",
  "source_url": "https://full-url",
  "domain": "domain.com",
  "title": "Article Title",
  "summary": "2-3 sentence summary of key information",
  "key_points": ["specific fact 1", "specific fact 2", "specific fact 3"],
  "entities": ["openai", "gpt-5", "sam-altman"],
  "tags": ["ai", "news", "product-launch"],
  "timestamp": "2026-04-02T14:30:00Z",
  "content_hash": "",
  "source_rank": 0.9,
  "source_tier": "major_media"
}
```

**Entity Normalization Rules:**
- Lowercase and trim whitespace
- Apply known aliases: `{"open ai": "openai", "gpt 5": "gpt-5", "microsoft corp": "microsoft", "google deepmind": "deepmind"}`
- For output display, capitalize: `"openai" → "OpenAI"`

### Step 8: Cross-Reference

Compare findings across sources:

- **Consensus**: facts confirmed by 2+ independent sources → high confidence
- **Contradictions**: sources disagree on specifics → flag both claims with attribution
- **Unique claims**: only one source reports it → note as unconfirmed

### Step 9: Store Novel Insights

Storage is handled automatically by the TypeScript infrastructure (`researchCapture.ts`).
When MCP tool results flow through the LLM router, structured research and nitter data
are automatically detected, deduplicated, and stored in LanceDB.

**No manual storage steps needed** — the infrastructure handles:
- Research findings → `research_findings` table
- Nitter tweets → `nitter_posts` table
- Nitter users → `nitter_users` table
- Nitter relationships → `nitter_relationships` table

### Step 10: Synthesize Report

Produce a structured report in this format:

```markdown
## Research Report: {Topic}

### Summary
{2-3 paragraph synthesis with confidence assessment}

### Key Findings
- {finding} — [Source]({url}), {source_tier}

### Consensus
- {fact confirmed by 2+ sources}

### Contradictions
- {conflicting claim A} ([Source1]) vs {claim B} ([Source2])

### Sources
| Source | Domain | Tier | Date |
|--------|--------|------|------|
| [Title](url) | domain.com | major_media | 2026-04-02 |

### Entities
- {normalized entity list, display form}

### Memory Status
- {N} findings retrieved from LanceDB
- {M} new findings stored
- {K} duplicates skipped
```

## Content Hash Generation

```
hash_input = lowercase(title) + source_url + publish_date_if_available
content_hash = SHA256(hash_input)
```

Fallback when no publish date is available:
```
hash_input = lowercase(title) + source_url + first_200_chars_of_content
```

This handles:
- Same URL with updated content (live blogs, updated articles)
- Same article syndicated to different URLs (different hash = stored separately)

## Helper Scripts

- **Dedup check**: `.claude/skills/web-research/scripts/lancedb-check.sh`
- **Storage**: Handled automatically by `researchCapture.ts` in the LLM router (no bash scripts needed)

Run these via the Bash tool. See [LanceDB queries reference](./references/lancedb-queries.md) for schema details.

## Environment Variables

| Variable | Purpose | Default |
|----------|---------|---------|
| `LANCEDB_URI` | LanceDB REST API base URL | `http://lancedb-api:8000` |
| `OLLAMA_BASE_URL` | Ollama API for embeddings | `http://ollama:11434` |
| `EMBEDDING_MODEL` | Ollama embedding model | `nomic-embed-text` |
