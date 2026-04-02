# Search Strategies Reference

## Query Decomposition

Break broad topics into 3-5 targeted sub-queries covering different angles:

| Broad Query | Sub-Queries |
|-------------|-------------|
| "What's happening in AI?" | "AI product launches", "AI research papers", "AI company funding", "AI policy regulation" |
| "Climate change news" | "climate policy updates", "extreme weather events", "renewable energy progress", "climate research findings" |
| "Tech industry layoffs" | "big tech layoffs announcements", "startup workforce changes", "tech hiring trends", "tech industry restructuring" |

## Canonical Intent Normalization

### Algorithm

```
1. input = lowercase(query)
2. tokens = split(input, whitespace)
3. tokens = remove_stopwords(tokens)
4. tokens = collapse_synonyms(tokens)
5. tokens = sort(tokens)
6. canonical = join(tokens, " ")
```

### Stopword List

Remove these words — they add no semantic value for dedup:

```
today, latest, recent, current, breaking, just, now,
the, a, an, is, are, was, were, be, been,
what, how, who, where, when, why, which,
about, in, on, for, of, to, from, with, at, by,
tell, me, find, show, get, give, let, know,
please, can, could, would, should
```

### Synonym Map

Collapse these to canonical forms:

| Canonical | Synonyms |
|-----------|----------|
| news | updates, developments, happenings, stories |
| advances | breakthroughs, progress, improvements |
| research | studies, papers, findings, investigations |
| company | companies, firm, firms, corporation, corp |
| launch | launches, released, announced, unveiled |
| funding | investment, investments, fundraising, raised |

### Modifier Preservation

**Critical**: do NOT collapse modifiers that distinguish intent.

Modifiers to KEEP (they differentiate topics):
- Domain qualifiers: safety, funding, regulation, policy, ethics, research
- Entity qualifiers: OpenAI, Google, Microsoft, EU, US
- Category qualifiers: hardware, software, robotics, language-models

Modifiers to REMOVE (they're temporal/filler):
- today, latest, recent, current, breaking, new, just

**Examples:**
```
"latest AI safety news today"      → "ai news safety"
"AI funding updates this week"     → "ai funding news"
"recent OpenAI announcements"      → "ai announcements openai"
"what's happening in AI"           → "ai"
"tell me about AI regulation news" → "ai news regulation"
```

## Source Quality Tiers

### Numeric Scoring

| Tier | Score | Match Patterns |
|------|-------|----------------|
| official | 1.0 | `*.gov`, `*.edu`, `*.org` (established), company newsrooms |
| major_media | 0.9 | `reuters.com`, `apnews.com`, `nytimes.com`, `bbc.com`, `bbc.co.uk`, `theguardian.com`, `washingtonpost.com`, `arstechnica.com`, `theverge.com`, `wired.com`, `techcrunch.com`, `bloomberg.com` |
| specialized | 0.8 | `arxiv.org`, `nature.com`, `science.org`, `ieee.org`, `acm.org`, `openai.com/blog`, `ai.googleblog.com`, `huggingface.co/blog` |
| blog | 0.6 | `medium.com`, `substack.com`, personal domains, company blogs |
| forum | 0.4 | `reddit.com`, `news.ycombinator.com`, `twitter.com/x.com`, `stackoverflow.com` |
| seo_farm | 0.0 | Content aggregators, SEO-optimized clickbait, mirror sites — **SKIP ENTIRELY** |

### Recency Weight

```
age < 24 hours:  weight = 1.0
age < 7 days:    weight = 0.9
age < 30 days:   weight = 0.7
age > 30 days:   weight = 0.5
```

### Final Score Formula

```
final_score = relevance * source_rank * recency_weight
```

Where `relevance` is estimated from search result position (1st = 1.0, 2nd = 0.95, 3rd = 0.9, etc.)

## Entity Normalization

### Alias Map

| Canonical | Aliases |
|-----------|---------|
| openai | open ai, open-ai |
| gpt-5 | gpt 5, gpt5 |
| deepmind | google deepmind, google deep mind |
| microsoft | microsoft corp, microsoft corporation, msft |
| google | alphabet, googl |
| meta | meta platforms, facebook |
| anthropic | anthropic ai |
| nvidia | nvidia corp, nvidia corporation, nvda |
| sam-altman | sam altman, samuel altman |
| elon-musk | elon musk |
| sundar-pichai | sundar pichai |

### Display Form Map

For output rendering, convert normalized form back to proper display:

| Normalized | Display |
|------------|---------|
| openai | OpenAI |
| gpt-5 | GPT-5 |
| deepmind | DeepMind |
| microsoft | Microsoft |
| anthropic | Anthropic |
| nvidia | NVIDIA |
| sam-altman | Sam Altman |

## Temporal Query Patterns

| Pattern | Interpretation |
|---------|---------------|
| "today", "this morning" | Last 24 hours |
| "this week" | Last 7 days |
| "this month" | Last 30 days |
| "in 2025", "last year" | Calendar year 2025 |
| "in March 2026" | March 1-31, 2026 |
| "yesterday" | 24-48 hours ago |
| No temporal marker | All time (use cached) |
