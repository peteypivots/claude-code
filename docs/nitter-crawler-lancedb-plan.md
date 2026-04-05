# Plan: Nitter Social Graph Crawler (LanceDB Version)

## Overview
MCP-integrated crawler with **LanceDB** storage. Crawls seed accounts → their followings (depth-1) → tweets. Prioritizes by follower count + engagement. Supports semantic search via embeddings.

---

## LanceDB Configuration

```bash
LANCEDB_URI=http://lancedb-api:8000  # Inside Docker
LANCEDB_DB=user_dbs
OLLAMA_BASE_URL=http://ollama:11434
EMBEDDING_MODEL=nomic-embed-text     # 768-dim embeddings
```

---

## Table Schema (LanceDB)

### Existing Tables (Already Populated)

#### `nitter_posts` — Collected tweets (435 rows)
| Column | Type | Description |
|--------|------|-------------|
| `id` | string | UUID primary key |
| `tweet_id` | string | Twitter's tweet ID |
| `username` | string | Author handle |
| `text` | string | Tweet content |
| `pub_date` | string | ISO timestamp |
| `permalink` | string | Tweet URL |
| `mentions` | list | @mentioned users |
| `hashtags` | list | #hashtags |
| `quoted_user` | string | Quoted tweet author |
| `reply_to_user` | string | Reply parent author |
| `source_query` | string | Search query that found it |
| `content_hash` | string | SHA256 for dedup |
| `timestamp` | string | Crawl timestamp |
| `embedding` | float[768] | Semantic vector |
| `media_urls` | list | Attached media |
| `entities` | list | Extracted entities |
| `key_topics` | list | LLM-extracted topics |

#### `nitter_users` — Tracked accounts (26 rows)
| Column | Type | Description |
|--------|------|-------------|
| `id` | string | UUID primary key |
| `username` | string | Handle (lowercased) |
| `display_name` | string | Profile name |
| `bio` | string | Profile bio |
| `category` | string | Account type (seed/discovered) |
| `discovered_from` | string | How we found them |
| `discovery_method` | string | search/timeline/mention |
| `crawl_priority` | double | Priority score |
| `follower_estimate` | int64 | Follower count |
| `first_seen` | string | First crawl timestamp |
| `last_crawled` | string | Last crawl timestamp |
| `tags` | list | User tags |
| `embedding` | float[768] | Bio embedding |

#### `nitter_relationships` — Interaction edges (mentions/replies/quotes)
| Column | Type | Description |
|--------|------|-------------|
| `id` | string | UUID |
| `source_user` | string | From user |
| `target_user` | string | To user |
| `relationship_type` | string | mention/reply/quote/retweet |
| `edge_hash` | string | Hash for dedup |
| `first_seen` | string | First occurrence |
| `last_seen` | string | Latest occurrence |
| `context` | string | Tweet context |

### New Tables to Create

#### `nitter_follows` — Social graph edges (who follows whom)
| Column | Type | Description |
|--------|------|-------------|
| `id` | string | UUID |
| `source_user` | string | Follower |
| `target_user` | string | Followed |
| `edge_hash` | string | SHA256(source+target) for dedup |
| `discovered_at` | string | When edge was found |

#### `crawler_state` — Key-value state tracking
| Column | Type | Description |
|--------|------|-------------|
| `id` | string | UUID |
| `key` | string | State key (e.g., "last_cycle_at") |
| `value` | string | State value (JSON-encoded) |
| `updated_at` | string | Last update timestamp |

---

## LanceDB API Reference

### Query (Filter-based)
```bash
curl -X POST "$LANCEDB_URI/dbs/$DB/tables/$TABLE/query" \
  -H "Content-Type: application/json" \
  -d '{"filter": "username = '\''elonmusk'\''", "limit": 10}'
# Response: {"records": [...]}
```

### Vector Search (Semantic)
```bash
curl -X POST "$LANCEDB_URI/dbs/$DB/tables/$TABLE/search" \
  -H "Content-Type: application/json" \
  -d '{"query_vector": [0.1, 0.2, ...], "limit": 10}'
# Response: {"results": [...]}
```

### Ingest (Insert)
```bash
curl -X POST "$LANCEDB_URI/dbs/$DB/tables/$TABLE/ingest" \
  -H "Content-Type: application/json" \
  -d '{"records": [{"id": "...", "username": "...", ...}]}'
```

### Delete (by Filter)
```bash
curl -X DELETE "$LANCEDB_URI/dbs/$DB/tables/$TABLE/delete" \
  -H "Content-Type: application/json" \
  -d '{"filter": "username = '\''olduser'\''"}'
```

**Note**: LanceDB has no UPDATE. Pattern: delete by filter + insert new record.

---

## MCP Tools (`mcp_server/src/nitter_crawler.py`)

### 1. `crawler_add_seed` — Add seed account
```python
@mcp.tool()
async def crawler_add_seed(username: str) -> dict:
    """Add a seed account to start crawling from."""
    username = username.lower().lstrip('@')
    
    # 1. Validate user exists via nitter MCP
    user_info = await nitter_user_profile(username)
    if not user_info or user_info.get("error"):
        return {"error": f"User {username} not found"}
    
    # 2. Check if already exists
    existing = await lancedb_query("nitter_users", f"username = '{username}'", limit=1)
    
    # 3. Prepare record
    record = {
        "id": str(uuid4()),
        "username": username,
        "display_name": user_info.get("name", ""),
        "bio": user_info.get("bio", ""),
        "category": "seed",
        "discovered_from": "manual",
        "discovery_method": "seed",
        "crawl_priority": 100.0,  # Seeds get max priority
        "follower_estimate": user_info.get("followers", 0),
        "first_seen": datetime.now().isoformat(),
        "last_crawled": None,
        "tags": ["seed"],
        "embedding": await generate_embedding(user_info.get("bio", username))
    }
    
    if existing.get("records"):
        # Update: delete + insert
        await lancedb_delete("nitter_users", f"username = '{username}'")
        record["first_seen"] = existing["records"][0].get("first_seen")
    
    await lancedb_ingest("nitter_users", [record])
    
    # 4. Trigger following crawl
    await crawler_crawl_following(username)
    
    return {"status": "added", "username": username, "followers": record["follower_estimate"]}
```

### 2. `crawler_discover` — Find accounts by keyword search
```python
@mcp.tool()
async def crawler_discover(query: str, limit: int = 20) -> dict:
    """Discover accounts by searching for keywords/topics."""
    # 1. Search users via nitter MCP
    results = await nitter_search_users(query, limit=limit)
    users = results.get("users", [])
    
    added = 0
    for user in users:
        username = user["username"].lower()
        
        # Skip if already tracked
        existing = await lancedb_query("nitter_users", f"username = '{username}'", limit=1)
        if existing.get("records"):
            continue
        
        record = {
            "id": str(uuid4()),
            "username": username,
            "display_name": user.get("name", ""),
            "bio": user.get("bio", ""),
            "category": "discovered",
            "discovered_from": query,
            "discovery_method": "search",
            "crawl_priority": 10.0,  # Low initial priority
            "follower_estimate": user.get("followers", 0),
            "first_seen": datetime.now().isoformat(),
            "last_crawled": None,
            "tags": [],
            "embedding": await generate_embedding(user.get("bio", username))
        }
        await lancedb_ingest("nitter_users", [record])
        added += 1
    
    return {"query": query, "found": len(users), "added": added}
```

### 3. `crawler_crawl_following` — Fetch who a user follows
```python
@mcp.tool()
async def crawler_crawl_following(username: str, max_pages: int = 5) -> dict:
    """Crawl following list for a user, add edges to graph."""
    username = username.lower().lstrip('@')
    following = []
    cursor = None
    pages = 0
    
    # Paginate through following
    while pages < max_pages:
        result = await nitter_user_following(username, cursor=cursor)
        if result.get("error"):
            break
        
        following.extend(result.get("users", []))
        cursor = result.get("next_cursor")
        pages += 1
        
        if not cursor:
            break
        await asyncio.sleep(1)  # Rate limit
    
    # Insert edges + discovered users
    edges_added = 0
    users_added = 0
    
    for user in following:
        target = user["username"].lower()
        edge_hash = hashlib.sha256(f"{username}{target}".encode()).hexdigest()
        
        # Check if edge exists
        existing_edge = await lancedb_query("nitter_follows", f"edge_hash = '{edge_hash}'", limit=1)
        if not existing_edge.get("records"):
            await lancedb_ingest("nitter_follows", [{
                "id": str(uuid4()),
                "source_user": username,
                "target_user": target,
                "edge_hash": edge_hash,
                "discovered_at": datetime.now().isoformat()
            }])
            edges_added += 1
        
        # Add user if not exists
        existing_user = await lancedb_query("nitter_users", f"username = '{target}'", limit=1)
        if not existing_user.get("records"):
            await lancedb_ingest("nitter_users", [{
                "id": str(uuid4()),
                "username": target,
                "display_name": user.get("name", ""),
                "bio": user.get("bio", ""),
                "category": "discovered",
                "discovered_from": username,
                "discovery_method": "following",
                "crawl_priority": 5.0,
                "follower_estimate": user.get("followers", 0),
                "first_seen": datetime.now().isoformat(),
                "last_crawled": None,
                "tags": [],
                "embedding": await generate_embedding(user.get("bio", target))
            }])
            users_added += 1
    
    # Update source user's last_crawled
    await update_user_field(username, "last_crawled", datetime.now().isoformat())
    
    return {
        "username": username,
        "following_count": len(following),
        "edges_added": edges_added,
        "users_added": users_added
    }
```

### 4. `crawler_collect_tweets` — Fetch recent tweets
```python
@mcp.tool()
async def crawler_collect_tweets(
    tier: int = None,
    min_priority: float = None,
    limit: int = 20
) -> dict:
    """Collect tweets from tracked accounts by tier or priority."""
    # Build filter
    filters = []
    if tier:
        priority_ranges = {1: (50, 999999), 2: (20, 50), 3: (0, 20)}
        lo, hi = priority_ranges.get(tier, (0, 999999))
        filters.append(f"crawl_priority >= {lo} AND crawl_priority < {hi}")
    if min_priority:
        filters.append(f"crawl_priority >= {min_priority}")
    
    filter_str = " AND ".join(filters) if filters else None
    
    # Get accounts ordered by priority (LanceDB doesn't support ORDER BY, so we fetch all and sort)
    result = await lancedb_query("nitter_users", filter_str, limit=limit * 2)
    accounts = sorted(
        result.get("records", []),
        key=lambda x: x.get("crawl_priority", 0),
        reverse=True
    )[:limit]
    
    new_tweets = 0
    accounts_polled = 0
    
    for account in accounts:
        username = account["username"]
        
        # Fetch tweets via nitter MCP
        tweets = await nitter_user_tweets(username, limit=20)
        if tweets.get("error"):
            continue
        
        accounts_polled += 1
        
        for tweet in tweets.get("tweets", []):
            tweet_id = tweet.get("id", tweet.get("tweet_id"))
            content_hash = hashlib.sha256(tweet_id.encode()).hexdigest()
            
            # Dedup check
            existing = await lancedb_query("nitter_posts", f"content_hash = '{content_hash}'", limit=1)
            if existing.get("records"):
                continue
            
            # Store tweet
            record = {
                "id": str(uuid4()),
                "tweet_id": tweet_id,
                "username": username,
                "text": tweet.get("text", ""),
                "pub_date": tweet.get("timestamp", ""),
                "permalink": tweet.get("url", ""),
                "mentions": tweet.get("mentions", []),
                "hashtags": tweet.get("hashtags", []),
                "quoted_user": tweet.get("quoted_user", ""),
                "reply_to_user": tweet.get("reply_to", ""),
                "source_query": f"timeline:{username}",
                "content_hash": content_hash,
                "timestamp": datetime.now().isoformat(),
                "embedding": await generate_embedding(tweet.get("text", "")),
                "media_urls": tweet.get("media", []),
                "entities": [],
                "key_topics": []
            }
            await lancedb_ingest("nitter_posts", [record])
            new_tweets += 1
        
        # Update engagement stats
        likes = sum(t.get("likes", 0) for t in tweets.get("tweets", []))
        retweets = sum(t.get("retweets", 0) for t in tweets.get("tweets", []))
        count = len(tweets.get("tweets", [])) or 1
        avg_engagement = (likes + retweets) / count
        
        await update_user_field(username, "last_crawled", datetime.now().isoformat())
        # Recalc priority: followers * 0.6 + engagement * 0.4
        new_priority = account.get("follower_estimate", 0) * 0.00006 + avg_engagement * 0.4
        await update_user_field(username, "crawl_priority", new_priority)
        
        await asyncio.sleep(0.5)  # Rate limit
    
    return {"accounts_polled": accounts_polled, "new_tweets": new_tweets}
```

### 5. `crawler_update_priorities` — Recalculate tiers
```python
@mcp.tool()
async def crawler_update_priorities() -> dict:
    """Recalculate priority scores based on followers + engagement."""
    # Get all users
    result = await lancedb_query("nitter_users", limit=10000)
    users = result.get("records", [])
    
    if not users:
        return {"error": "No users found"}
    
    # Sort by priority to determine tier cutoffs
    sorted_users = sorted(users, key=lambda x: x.get("crawl_priority", 0), reverse=True)
    total = len(sorted_users)
    
    tier1_cutoff = sorted_users[int(total * 0.1)]["crawl_priority"] if total > 10 else 50
    tier2_cutoff = sorted_users[int(total * 0.4)]["crawl_priority"] if total > 10 else 20
    
    tier_counts = {1: 0, 2: 0, 3: 0}
    for user in users:
        priority = user.get("crawl_priority", 0)
        if priority >= tier1_cutoff:
            tier_counts[1] += 1
        elif priority >= tier2_cutoff:
            tier_counts[2] += 1
        else:
            tier_counts[3] += 1
    
    return {
        "total_users": total,
        "tier_cutoffs": {"tier1": tier1_cutoff, "tier2": tier2_cutoff},
        "tier_counts": tier_counts
    }
```

### 6. `crawler_query_tweets` — Search stored tweets
```python
@mcp.tool()
async def crawler_query_tweets(
    username: str = None,
    keyword: str = None,
    semantic_query: str = None,
    since: str = None,
    limit: int = 50
) -> dict:
    """Query stored tweets. Use semantic_query for vector similarity search."""
    
    if semantic_query:
        # Vector search
        embedding = await generate_embedding(semantic_query)
        result = await lancedb_search("nitter_posts", embedding, limit=limit)
        tweets = result.get("results", [])
    else:
        # Filter-based query
        filters = []
        if username:
            filters.append(f"username = '{username.lower()}'")
        if keyword:
            # Note: LanceDB filter doesn't support LIKE. Use vector search for keywords.
            # Fallback: fetch all and filter in Python
            pass
        if since:
            filters.append(f"pub_date >= '{since}'")
        
        filter_str = " AND ".join(filters) if filters else None
        result = await lancedb_query("nitter_posts", filter_str, limit=limit)
        tweets = result.get("records", [])
        
        # Python-side keyword filter if needed
        if keyword:
            keyword_lower = keyword.lower()
            tweets = [t for t in tweets if keyword_lower in t.get("text", "").lower()]
    
    return {
        "count": len(tweets),
        "tweets": [
            {
                "tweet_id": t.get("tweet_id"),
                "username": t.get("username"),
                "text": t.get("text", "")[:280],
                "pub_date": t.get("pub_date"),
                "permalink": t.get("permalink")
            }
            for t in tweets
        ]
    }
```

### 7. `crawler_query_graph` — Query social graph
```python
@mcp.tool()
async def crawler_query_graph(
    username: str,
    direction: str = "following"
) -> dict:
    """Query the social graph for follow relationships."""
    username = username.lower().lstrip('@')
    
    if direction == "following":
        # Who does this user follow?
        result = await lancedb_query("nitter_follows", f"source_user = '{username}'", limit=1000)
        edges = result.get("records", [])
        target_field = "target_user"
    else:
        # Who follows this user?
        result = await lancedb_query("nitter_follows", f"target_user = '{username}'", limit=1000)
        edges = result.get("records", [])
        target_field = "source_user"
    
    # Enrich with user info
    users = []
    for edge in edges:
        target = edge.get(target_field)
        user_result = await lancedb_query("nitter_users", f"username = '{target}'", limit=1)
        if user_result.get("records"):
            user = user_result["records"][0]
            users.append({
                "username": target,
                "followers": user.get("follower_estimate", 0),
                "priority": user.get("crawl_priority", 0)
            })
        else:
            users.append({"username": target, "followers": 0, "priority": 0})
    
    # Sort by priority
    users.sort(key=lambda x: x["priority"], reverse=True)
    
    return {
        "username": username,
        "direction": direction,
        "count": len(users),
        "users": users[:50]  # Limit response size
    }
```

### 8. `crawler_stats` — Get crawler statistics
```python
@mcp.tool()
async def crawler_stats() -> dict:
    """Get crawler statistics and status."""
    # Count queries (LanceDB tables endpoint includes row_count)
    tables = await lancedb_list_tables()
    
    stats = {
        "tables": {},
        "tier_breakdown": {}
    }
    
    for table in tables:
        if table["name"].startswith("nitter_"):
            stats["tables"][table["name"]] = table.get("row_count", 0)
    
    # Get tier breakdown
    users_result = await lancedb_query("nitter_users", limit=10000)
    users = users_result.get("records", [])
    
    tier_counts = {1: 0, 2: 0, 3: 0}
    for user in users:
        priority = user.get("crawl_priority", 0)
        if priority >= 50:
            tier_counts[1] += 1
        elif priority >= 20:
            tier_counts[2] += 1
        else:
            tier_counts[3] += 1
    
    stats["tier_breakdown"] = tier_counts
    stats["seed_users"] = len([u for u in users if u.get("category") == "seed"])
    
    # Recent activity
    recent = await lancedb_query(
        "nitter_posts",
        f"timestamp >= '{(datetime.now() - timedelta(hours=1)).isoformat()}'",
        limit=1000
    )
    stats["tweets_last_hour"] = len(recent.get("records", []))
    
    return stats
```

### 9. `crawler_run_cycle` — Run one full crawl cycle
```python
@mcp.tool()
async def crawler_run_cycle() -> dict:
    """Run one full crawl cycle: update priorities, crawl by tier."""
    results = {}
    now = datetime.now()
    
    # 1. Update priorities
    results["priorities"] = await crawler_update_priorities()
    
    # 2. Get users by tier with stale check
    intervals = {
        1: timedelta(minutes=5),
        2: timedelta(minutes=15),
        3: timedelta(hours=1)
    }
    
    users_result = await lancedb_query("nitter_users", limit=10000)
    users = users_result.get("records", [])
    
    for tier, interval in intervals.items():
        cutoff = (now - interval).isoformat()
        tier_lo, tier_hi = {1: (50, 999999), 2: (20, 50), 3: (0, 20)}[tier]
        
        due_users = [
            u for u in users
            if tier_lo <= u.get("crawl_priority", 0) < tier_hi
            and (not u.get("last_crawled") or u.get("last_crawled") < cutoff)
        ]
        
        if due_users:
            # Collect tweets for this tier
            tier_result = await crawler_collect_tweets(tier=tier, limit=len(due_users))
            results[f"tier{tier}"] = tier_result
    
    return results
```

---

## Helper Functions

```python
# mcp_server/src/lancedb_helpers.py

LANCEDB_URI = os.getenv("LANCEDB_URI", "http://lancedb-api:8000")
LANCEDB_DB = os.getenv("LANCEDB_DB", "user_dbs")
OLLAMA_URL = os.getenv("OLLAMA_BASE_URL", "http://ollama:11434")
EMBEDDING_MODEL = os.getenv("EMBEDDING_MODEL", "nomic-embed-text")

async def lancedb_query(table: str, filter: str = None, limit: int = 100) -> dict:
    """Query LanceDB table with optional filter."""
    url = f"{LANCEDB_URI}/dbs/{LANCEDB_DB}/tables/{table}/query"
    payload = {"limit": limit}
    if filter:
        payload["filter"] = filter
    
    async with httpx.AsyncClient() as client:
        resp = await client.post(url, json=payload, timeout=30)
        if resp.status_code == 200:
            return resp.json()
        return {"records": [], "error": resp.text}

async def lancedb_search(table: str, vector: list, limit: int = 10) -> dict:
    """Vector similarity search."""
    url = f"{LANCEDB_URI}/dbs/{LANCEDB_DB}/tables/{table}/search"
    async with httpx.AsyncClient() as client:
        resp = await client.post(url, json={"query_vector": vector, "limit": limit}, timeout=30)
        if resp.status_code == 200:
            return resp.json()
        return {"results": [], "error": resp.text}

async def lancedb_ingest(table: str, records: list) -> dict:
    """Insert records into table (auto-creates if not exists)."""
    url = f"{LANCEDB_URI}/dbs/{LANCEDB_DB}/tables/{table}/ingest"
    async with httpx.AsyncClient() as client:
        resp = await client.post(url, json={"records": records}, timeout=30)
        return resp.json() if resp.status_code in (200, 201) else {"error": resp.text}

async def lancedb_delete(table: str, filter: str) -> dict:
    """Delete records matching filter."""
    url = f"{LANCEDB_URI}/dbs/{LANCEDB_DB}/tables/{table}/delete"
    async with httpx.AsyncClient() as client:
        resp = await client.request("DELETE", url, json={"filter": filter}, timeout=30)
        return resp.json() if resp.status_code == 200 else {"error": resp.text}

async def lancedb_list_tables() -> list:
    """List all tables with row counts."""
    url = f"{LANCEDB_URI}/dbs/{LANCEDB_DB}/tables"
    async with httpx.AsyncClient() as client:
        resp = await client.get(url, timeout=30)
        if resp.status_code == 200:
            return resp.json().get("tables", [])
        return []

async def generate_embedding(text: str) -> list:
    """Generate embedding via Ollama."""
    if not text:
        return [0.0] * 768  # Zero vector for empty text
    
    async with httpx.AsyncClient() as client:
        resp = await client.post(
            f"{OLLAMA_URL}/api/embed",
            json={"model": EMBEDDING_MODEL, "input": text[:8000]},  # Truncate long text
            timeout=60
        )
        if resp.status_code == 200:
            data = resp.json()
            return data.get("embeddings", [[0.0] * 768])[0]
        return [0.0] * 768

async def update_user_field(username: str, field: str, value) -> bool:
    """Update a single field on a user (delete + insert pattern)."""
    existing = await lancedb_query("nitter_users", f"username = '{username}'", limit=1)
    if not existing.get("records"):
        return False
    
    record = existing["records"][0]
    record[field] = value
    
    await lancedb_delete("nitter_users", f"username = '{username}'")
    await lancedb_ingest("nitter_users", [record])
    return True
```

---

## Usage Flow

```python
# 1. Add seed accounts
await crawler_add_seed("elonmusk")
await crawler_add_seed("sama")
await crawler_add_seed("ylecun")

# 2. Discover more accounts by topic
await crawler_discover("AI research")
await crawler_discover("machine learning startup")

# 3. Run crawl cycle (or let background runner do it)
await crawler_run_cycle()

# 4. Query collected data
# Keyword search
await crawler_query_tweets(keyword="GPT")

# Semantic search
await crawler_query_tweets(semantic_query="discussions about AI safety and alignment")

# Graph queries
await crawler_query_graph(username="elonmusk", direction="following")

# Stats
await crawler_stats()
```

---

## Files to Create/Modify

| File | Action |
|------|--------|
| `mcp_server/src/lancedb_helpers.py` | NEW — LanceDB client helpers |
| `mcp_server/src/nitter_crawler.py` | NEW — 9 MCP crawler tools |
| `mcp_server/src/server.py` | MODIFY — Import and register crawler tools |

---

## Key Differences from SQLite Version

| Aspect | SQLite | LanceDB |
|--------|--------|---------|
| **Storage** | Single file | REST API service |
| **Updates** | `UPDATE ... SET` | Delete + Insert pattern |
| **Search** | `LIKE '%keyword%'` | Vector similarity search |
| **Indexes** | Manual `CREATE INDEX` | Automatic on ingest |
| **Joins** | Native SQL joins | Multiple queries + Python join |
| **Sorting** | `ORDER BY` | Fetch + Python sort |
| **Embeddings** | Separate step | Built into ingest |

## Decisions

- **MCP-integrated**: All crawler operations exposed as MCP tools
- **LanceDB storage**: REST API, vector-native, auto-scaling
- **Semantic search**: Query tweets by meaning, not just keywords
- **Depth-1 graph**: Crawl followings of seeds only, not recursive
- **Tiered polling**: Tier 1 (5min), Tier 2 (15min), Tier 3 (1hr)
- **Priority formula**: `followers × 0.00006 + avg_engagement × 0.4` (scaled for LanceDB)
- **No embeddings for follows**: Social graph edges don't need vectors
