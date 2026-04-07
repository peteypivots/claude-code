/**
 * Nitter Social Graph Crawler — MCP Tools
 *
 * 9 tools for crawling Twitter/X via Nitter MCP and storing in LanceDB:
 *   1. crawler_add_seed     — Add seed account to crawl
 *   2. crawler_discover     — Find accounts by keyword search
 *   3. crawler_crawl_following — Build social graph (who follows whom)
 *   4. crawler_collect_tweets — Fetch tweets by tier
 *   5. crawler_update_priorities — Recalculate tier assignments
 *   6. crawler_query_tweets — Search stored tweets
 *   7. crawler_query_graph  — Query follow relationships
 *   8. crawler_stats        — Get crawler statistics
 *   9. crawler_run_cycle    — Run full crawl cycle
 */

import { createHash, randomUUID } from "node:crypto";
import {
  lancedbQuery,
  lancedbSearch,
  lancedbIngest,
  lancedbDelete,
  lancedbListTables,
  lancedbUpdateField,
  type LanceDBRecord,
} from "../../src/services/lancedb/index.js";
import {
  nitterSearchTweets,
  nitterUserTweets,
  nitterUserProfile,
  nitterSearchUsers,
  nitterHealth,
  nitterUserFollowing,
  nitterUserFollowers,
  type NitterTweet,
  type NitterFollowUser,
} from "./nitter-client.js";
import { generateEmbedding } from "./embeddings.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: {
    type: "object";
    properties: Record<string, unknown>;
    required?: string[];
  };
}

interface ToolResult {
  content: { type: "text"; text: string }[];
  [key: string]: unknown;  // Allow additional properties for MCP SDK compatibility
}

// ---------------------------------------------------------------------------
// Tool Definitions (exported for server registration)
// ---------------------------------------------------------------------------

export const crawlerToolDefinitions: ToolDefinition[] = [
  {
    name: "crawler_add_seed",
    description:
      "Add a seed account to start crawling. Seeds get highest priority and their following lists are crawled immediately.",
    inputSchema: {
      type: "object",
      properties: {
        username: {
          type: "string",
          description: "Twitter username (without @)",
        },
      },
      required: ["username"],
    },
  },
  {
    name: "crawler_discover",
    description:
      "Discover new accounts by searching for keywords. Found users are added with low priority.",
    inputSchema: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "Keywords to search for",
        },
        limit: {
          type: "number",
          description: "Max users to discover (default: 20)",
        },
      },
      required: ["query"],
    },
  },
  {
    name: "crawler_crawl_following",
    description:
      "Crawl the following list of a user and add edges to the social graph.",
    inputSchema: {
      type: "object",
      properties: {
        username: {
          type: "string",
          description: "Username to crawl following for",
        },
        max_pages: {
          type: "number",
          description: "Max pages of following to fetch (default: 5)",
        },
      },
      required: ["username"],
    },
  },
  {
    name: "crawler_collect_tweets",
    description:
      "Collect recent tweets from tracked accounts, optionally filtered by tier (1=high, 2=med, 3=low priority).",
    inputSchema: {
      type: "object",
      properties: {
        tier: {
          type: "number",
          description: "Filter by tier (1, 2, or 3). Omit for all.",
        },
        min_priority: {
          type: "number",
          description: "Minimum priority score threshold",
        },
        limit: {
          type: "number",
          description: "Max accounts to poll (default: 20)",
        },
      },
    },
  },
  {
    name: "crawler_update_priorities",
    description:
      "Recalculate priority scores for all users based on followers and engagement. Returns tier distribution.",
    inputSchema: {
      type: "object",
      properties: {},
    },
  },
  {
    name: "crawler_query_tweets",
    description:
      "Search stored tweets by username, keyword, semantic query, or date range.",
    inputSchema: {
      type: "object",
      properties: {
        username: {
          type: "string",
          description: "Filter by username",
        },
        keyword: {
          type: "string",
          description: "Keyword to search in tweet text",
        },
        semantic_query: {
          type: "string",
          description: "Natural language query for semantic similarity search",
        },
        since: {
          type: "string",
          description: "ISO date string for minimum date",
        },
        limit: {
          type: "number",
          description: "Max results (default: 50)",
        },
      },
    },
  },
  {
    name: "crawler_query_graph",
    description: "Query the social graph to find who a user follows or who follows them.",
    inputSchema: {
      type: "object",
      properties: {
        username: {
          type: "string",
          description: "Username to query graph for",
        },
        direction: {
          type: "string",
          enum: ["following", "followers"],
          description: "Direction: 'following' (who they follow) or 'followers' (who follows them)",
        },
      },
      required: ["username"],
    },
  },
  {
    name: "crawler_stats",
    description:
      "Get crawler statistics: total users, tweets, edges, tier breakdown.",
    inputSchema: {
      type: "object",
      properties: {},
    },
  },
  {
    name: "crawler_run_cycle",
    description:
      "Run one full crawl cycle: update priorities, then collect tweets for each tier based on staleness.",
    inputSchema: {
      type: "object",
      properties: {},
    },
  },
  {
    name: "crawler_expand_graph",
    description:
      "Expand the social graph by crawling real following/followers for a user. Uses nitter_user_following and nitter_user_followers endpoints to build actual follow relationships (not just mentions).",
    inputSchema: {
      type: "object",
      properties: {
        username: {
          type: "string",
          description: "Username to expand graph for",
        },
        direction: {
          type: "string",
          enum: ["following", "followers", "both"],
          description: "Direction: 'following', 'followers', or 'both' (default: both)",
        },
        limit: {
          type: "number",
          description: "Max follows to fetch per direction (default: 100)",
        },
      },
      required: ["username"],
    },
  },
  {
    name: "crawler_backfill",
    description:
      "Historical backfill for users with no posts. Fetches up to 200 tweets for each user that has never been scraped. Run this to catch up on seed users.",
    inputSchema: {
      type: "object",
      properties: {
        limit: {
          type: "number",
          description: "Max users to backfill (default: 5)",
        },
        tweets_per_user: {
          type: "number",
          description: "Max tweets to fetch per user (default: 100)",
        },
        category: {
          type: "string",
          description: "Only backfill users in this category (e.g., 'seed')",
        },
      },
    },
  },
];

// ---------------------------------------------------------------------------
// Helper Functions
// ---------------------------------------------------------------------------

function sha256(input: string): string {
  return createHash("sha256").update(input).digest("hex");
}

function now(): string {
  return new Date().toISOString();
}

function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// ---------------------------------------------------------------------------
// Tool Implementations
// ---------------------------------------------------------------------------

async function crawlerAddSeed(
  args: Record<string, unknown>
): Promise<ToolResult> {
  const username = String(args.username ?? "")
    .toLowerCase()
    .replace(/^@/, "");
  if (!username) {
    return json({ error: "username is required" });
  }

  // Validate user exists via nitter
  const profile = await nitterUserProfile(username);
  if (profile.error || !profile.user) {
    return json({ error: `User not found: ${username}`, details: profile.error });
  }

  // Check if already exists
  const existing = await lancedbQuery(
    "nitter_users",
    `username = '${username}'`,
    1
  );

  const record: LanceDBRecord = {
    id: randomUUID(),
    username,
    display_name: profile.user.name ?? "",
    bio: profile.user.bio ?? "",
    category: "seed",
    discovered_from: "manual",
    discovery_method: "seed",
    crawl_priority: 100.0, // Seeds get max priority
    follower_estimate: profile.user.followers ?? 0,
    first_seen: now(),
    last_crawled: "",
    tags: ["seed"],
    embedding: await generateEmbedding(profile.user.bio ?? username),
  };

  if (existing.records.length > 0) {
    // Update existing: preserve first_seen
    record.first_seen = (existing.records[0] as Record<string, unknown>).first_seen as string;
    await lancedbDelete("nitter_users", `username = '${username}'`);
  }

  await lancedbIngest("nitter_users", [record]);

  return json({
    status: "added",
    username,
    followers: record.follower_estimate,
    category: "seed",
  });
}

async function crawlerDiscover(
  args: Record<string, unknown>
): Promise<ToolResult> {
  const query = String(args.query ?? "");
  const limit = Number(args.limit ?? 20);

  if (!query) {
    return json({ error: "query is required" });
  }

  const results = await nitterSearchUsers(query, limit);
  if (results.error) {
    return json({ error: results.error });
  }

  let added = 0;
  for (const user of results.users) {
    const username = user.username.toLowerCase();

    // Skip if already tracked
    const existing = await lancedbQuery(
      "nitter_users",
      `username = '${username}'`,
      1
    );
    if (existing.records.length > 0) continue;

    const record: LanceDBRecord = {
      id: randomUUID(),
      username,
      display_name: user.name ?? "",
      bio: user.bio ?? "",
      category: "discovered",
      discovered_from: query,
      discovery_method: "search",
      crawl_priority: 10.0, // Low initial priority
      follower_estimate: user.followers ?? 0,
      first_seen: now(),
      last_crawled: "",
      tags: [],
      embedding: await generateEmbedding(user.bio ?? username),
    };

    await lancedbIngest("nitter_users", [record]);
    added++;
  }

  return json({
    query,
    found: results.users.length,
    added,
  });
}

async function crawlerCrawlFollowing(
  args: Record<string, unknown>
): Promise<ToolResult> {
  const username = String(args.username ?? "")
    .toLowerCase()
    .replace(/^@/, "");
  // Note: max_pages not fully implemented as nitter-mcp doesn't expose following list directly
  // This would require the nitter_user_following tool which may not exist

  if (!username) {
    return json({ error: "username is required" });
  }

  // For now, we can discover related users from their tweets (mentions, quotes)
  const timeline = await nitterUserTweets(username, 50);
  if (timeline.error) {
    return json({ error: timeline.error });
  }

  // Extract mentioned users from tweet text (e.g., "R to @user:" or "@mention in text")
  const discoveredUsers = new Set<string>();
  const mentionRegex = /@([a-zA-Z0-9_]+)/g;
  
  for (const tweet of timeline.tweets) {
    // Extract from description/title (main tweet text)
    const text = (tweet as unknown as Record<string, unknown>).description ?? 
                 (tweet as unknown as Record<string, unknown>).title ?? "";
    const textStr = String(text);
    
    let match: RegExpExecArray | null;
    // biome-ignore lint: need to use exec in loop for regex matching
    while ((match = mentionRegex.exec(textStr)) !== null) {
      discoveredUsers.add(match[1].toLowerCase());
    }
  }

  // Remove self
  discoveredUsers.delete(username);

  let edgesAdded = 0;
  let usersAdded = 0;

  for (const target of discoveredUsers) {
    const edgeHash = sha256(`${username}${target}`);

    // Check if edge exists in nitter_follows
    const existingEdge = await lancedbQuery(
      "nitter_follows",
      `edge_hash = '${edgeHash}'`,
      1
    );

    if (existingEdge.records.length === 0) {
      await lancedbIngest("nitter_follows", [
        {
          id: randomUUID(),
          source_user: username,
          target_user: target,
          edge_hash: edgeHash,
          relationship_type: "interacts_with",
          discovered_at: now(),
        },
      ]);
      edgesAdded++;
    }

    // Add user if not exists
    const existingUser = await lancedbQuery(
      "nitter_users",
      `username = '${target}'`,
      1
    );

    if (existingUser.records.length === 0) {
      await lancedbIngest("nitter_users", [
        {
          id: randomUUID(),
          username: target,
          display_name: "",
          bio: "",
          category: "discovered",
          discovered_from: username,
          discovery_method: "interaction",
          crawl_priority: 5.0,
          follower_estimate: 0,
          first_seen: now(),
          last_crawled: "",
          tags: [],
          embedding: await generateEmbedding(target),
        },
      ]);
      usersAdded++;
    }
  }

  // Update source user's last_crawled
  await lancedbUpdateField("nitter_users", "username", username, {
    last_crawled: now(),
  });

  return json({
    username,
    tweets_analyzed: timeline.tweets.length,
    edges_added: edgesAdded,
    users_added: usersAdded,
  });
}

async function crawlerCollectTweets(
  args: Record<string, unknown>
): Promise<ToolResult> {
  const tier = args.tier as number | undefined;
  const minPriority = args.min_priority as number | undefined;
  const limit = Number(args.limit ?? 20);

  // Determine priority range for tier
  let priorityFilter = "";
  if (tier) {
    const ranges: Record<number, [number, number]> = {
      1: [50, 999999],
      2: [20, 50],
      3: [0, 20],
    };
    const [lo, hi] = ranges[tier] ?? [0, 999999];
    priorityFilter = `crawl_priority >= ${lo} AND crawl_priority < ${hi}`;
  } else if (minPriority !== undefined) {
    priorityFilter = `crawl_priority >= ${minPriority}`;
  }

  // Get accounts (LanceDB doesn't support ORDER BY, so fetch more and sort in JS)
  const result = await lancedbQuery(
    "nitter_users",
    priorityFilter || undefined,
    limit * 2
  );

  const accounts = result.records
    .sort(
      (a, b) =>
        ((b as Record<string, unknown>).crawl_priority as number ?? 0) -
        ((a as Record<string, unknown>).crawl_priority as number ?? 0)
    )
    .slice(0, limit);

  let newTweets = 0;
  let accountsPolled = 0;

  for (const account of accounts) {
    const username = (account as Record<string, unknown>).username as string;

    const tweets = await nitterUserTweets(username, 20);
    if (tweets.error) continue;

    accountsPolled++;

    for (const tweet of tweets.tweets) {
      const tweetId = tweet.tweet_id ?? tweet.permalink?.split("/").pop() ?? "";
      if (!tweetId) continue;

      const contentHash = sha256(tweetId);

      // Dedup check
      const existing = await lancedbQuery(
        "nitter_posts",
        `content_hash = '${contentHash}'`,
        1
      );
      if (existing.records.length > 0) continue;

      // Store tweet
      const record: LanceDBRecord = {
        id: randomUUID(),
        tweet_id: tweetId,
        username,
        text: tweet.text ?? "",
        pub_date: tweet.pub_date ?? tweet.timestamp ?? "",
        permalink: tweet.permalink ?? tweet.url ?? "",
        mentions: tweet.mentions ?? [],
        hashtags: tweet.hashtags ?? [],
        quoted_user: tweet.quoted_user ?? "",
        reply_to_user: tweet.reply_to_user ?? tweet.reply_to ?? "",
        source_query: `timeline:${username}`,
        content_hash: contentHash,
        timestamp: now(),
        embedding: await generateEmbedding(tweet.text ?? ""),
        media_urls: tweet.media_urls ?? tweet.media ?? [],
        entities: [],
        key_topics: [],
      };

      await lancedbIngest("nitter_posts", [record]);
      newTweets++;
    }

    // Calculate engagement
    const totalLikes = tweets.tweets.reduce(
      (sum, t) => sum + (t.likes ?? 0),
      0
    );
    const totalRts = tweets.tweets.reduce(
      (sum, t) => sum + (t.retweets ?? 0),
      0
    );
    const count = tweets.tweets.length || 1;
    const avgEngagement = (totalLikes + totalRts) / count;

    // Update user
    const followerEst = (account as Record<string, unknown>).follower_estimate as number ?? 0;
    const newPriority = followerEst * 0.00006 + avgEngagement * 0.4;

    await lancedbUpdateField("nitter_users", "username", username, {
      last_crawled: now(),
      crawl_priority: newPriority,
    });

    await delay(500); // Rate limit
  }

  return json({
    accounts_polled: accountsPolled,
    new_tweets: newTweets,
    tier: tier ?? "all",
  });
}

async function crawlerUpdatePriorities(): Promise<ToolResult> {
  const result = await lancedbQuery("nitter_users", undefined, 10000);
  const users = result.records;

  if (users.length === 0) {
    return json({ error: "No users found" });
  }

  // Get all follow edges to find who seeds follow
  const followsResult = await lancedbQuery("nitter_follows", "relationship_type = 'follows'", 10000);
  const followEdges = followsResult.records;

  // Build map of users followed by seeds
  const seedUsernames = new Set<string>();
  const followedBySeed = new Map<string, number>(); // username -> count of seeds following them

  for (const user of users) {
    if ((user as Record<string, unknown>).category === "seed") {
      seedUsernames.add((user as Record<string, unknown>).username as string);
    }
  }

  for (const edge of followEdges) {
    const source = (edge as Record<string, unknown>).source_user as string;
    const target = (edge as Record<string, unknown>).target_user as string;
    if (seedUsernames.has(source)) {
      followedBySeed.set(target, (followedBySeed.get(target) ?? 0) + 1);
    }
  }

  // Recalculate priorities
  let updated = 0;
  for (const user of users) {
    const rec = user as Record<string, unknown>;
    const username = rec.username as string;
    const category = rec.category as string ?? "";
    const currentPriority = rec.crawl_priority as number ?? 0;
    const followerEstimate = rec.follower_estimate as number ?? 0;

    let newPriority = currentPriority;

    // Seeds always get 100
    if (category === "seed") {
      newPriority = 100;
    }
    // Users followed by multiple seeds get high priority
    else if (followedBySeed.has(username)) {
      const seedCount = followedBySeed.get(username)!;
      // 50 base + 10 per additional seed following
      newPriority = Math.min(90, 50 + (seedCount - 1) * 10);
    }
    // Users followed by one seed get medium priority
    else if (followedBySeed.has(username)) {
      newPriority = 50;
    }
    // Users with high followers get a boost
    else if (followerEstimate > 100000) {
      newPriority = Math.max(newPriority, 30);
    }
    else if (followerEstimate > 10000) {
      newPriority = Math.max(newPriority, 20);
    }

    // Update if changed
    if (newPriority !== currentPriority) {
      await lancedbUpdateField(
        "nitter_users",
        `username = '${username}'`,
        "crawl_priority",
        newPriority
      );
      updated++;
    }
  }

  // Recalculate tier distribution after updates
  const updatedResult = await lancedbQuery("nitter_users", undefined, 10000);
  const updatedUsers = updatedResult.records;

  const sorted = updatedUsers.sort(
    (a, b) =>
      ((b as Record<string, unknown>).crawl_priority as number ?? 0) -
      ((a as Record<string, unknown>).crawl_priority as number ?? 0)
  );

  const total = sorted.length;
  // Fixed tier cutoffs based on actual priority values (not percentiles of low values)
  const tier1Cutoff = 50; // Seeds and users followed by seeds
  const tier2Cutoff = 20; // Graph-expanded users

  const tierCounts = { 1: 0, 2: 0, 3: 0 };
  for (const user of updatedUsers) {
    const priority = (user as Record<string, unknown>).crawl_priority as number ?? 0;
    if (priority >= tier1Cutoff) tierCounts[1]++;
    else if (priority >= tier2Cutoff) tierCounts[2]++;
    else tierCounts[3]++;
  }

  return json({
    total_users: total,
    priorities_updated: updated,
    tier_cutoffs: { tier1: tier1Cutoff, tier2: tier2Cutoff },
    tier_counts: tierCounts,
  });
}

async function crawlerQueryTweets(
  args: Record<string, unknown>
): Promise<ToolResult> {
  const username = args.username as string | undefined;
  const keyword = args.keyword as string | undefined;
  const semanticQuery = args.semantic_query as string | undefined;
  const since = args.since as string | undefined;
  const limit = Number(args.limit ?? 50);

  let tweets: LanceDBRecord[];

  if (semanticQuery) {
    // Vector search
    const embedding = await generateEmbedding(semanticQuery);
    const result = await lancedbSearch("nitter_posts", embedding, limit);
    tweets = result.results;
  } else {
    // Filter-based query
    const filters: string[] = [];
    if (username) filters.push(`username = '${username.toLowerCase()}'`);
    if (since) filters.push(`pub_date >= '${since}'`);

    const filter = filters.length > 0 ? filters.join(" AND ") : undefined;
    const result = await lancedbQuery("nitter_posts", filter, limit * 2);
    tweets = result.records;

    // Python-side keyword filter
    if (keyword) {
      const kw = keyword.toLowerCase();
      tweets = tweets.filter((t) =>
        ((t as Record<string, unknown>).text as string ?? "").toLowerCase().includes(kw)
      );
    }

    tweets = tweets.slice(0, limit);
  }

  return json({
    count: tweets.length,
    tweets: tweets.map((t) => ({
      tweet_id: (t as Record<string, unknown>).tweet_id,
      username: (t as Record<string, unknown>).username,
      text: ((t as Record<string, unknown>).text as string ?? "").slice(0, 280),
      pub_date: (t as Record<string, unknown>).pub_date,
      permalink: (t as Record<string, unknown>).permalink,
    })),
  });
}

async function crawlerQueryGraph(
  args: Record<string, unknown>
): Promise<ToolResult> {
  const username = String(args.username ?? "")
    .toLowerCase()
    .replace(/^@/, "");
  const direction = String(args.direction ?? "following");

  if (!username) {
    return json({ error: "username is required" });
  }

  const filter =
    direction === "following"
      ? `source_user = '${username}'`
      : `target_user = '${username}'`;

  const result = await lancedbQuery("nitter_follows", filter, 1000);
  const edges = result.records;

  const targetField = direction === "following" ? "target_user" : "source_user";

  // Enrich with user info
  const users: { username: string; followers: number; priority: number }[] = [];

  for (const edge of edges.slice(0, 100)) {
    // Limit enrichment
    const target = (edge as Record<string, unknown>)[targetField] as string;
    const userResult = await lancedbQuery(
      "nitter_users",
      `username = '${target}'`,
      1
    );

    if (userResult.records.length > 0) {
      const user = userResult.records[0] as Record<string, unknown>;
      users.push({
        username: target,
        followers: (user.follower_estimate as number) ?? 0,
        priority: (user.crawl_priority as number) ?? 0,
      });
    } else {
      users.push({ username: target, followers: 0, priority: 0 });
    }
  }

  users.sort((a, b) => b.priority - a.priority);

  return json({
    username,
    direction,
    count: edges.length,
    users: users.slice(0, 50),
  });
}

async function crawlerStats(): Promise<ToolResult> {
  const tables = await lancedbListTables();

  const stats: Record<string, unknown> = {
    tables: {} as Record<string, number>,
    tier_breakdown: { 1: 0, 2: 0, 3: 0 },
    seed_users: 0,
    tweets_last_hour: 0,
  };

  for (const table of tables) {
    if (table.name.startsWith("nitter_")) {
      (stats.tables as Record<string, number>)[table.name] = table.row_count;
    }
  }

  // Get tier breakdown
  const usersResult = await lancedbQuery("nitter_users", undefined, 10000);
  const users = usersResult.records;

  for (const user of users) {
    const priority = (user as Record<string, unknown>).crawl_priority as number ?? 0;
    const category = (user as Record<string, unknown>).category as string ?? "";

    if (category === "seed") (stats.seed_users as number)++;

    if (priority >= 50) (stats.tier_breakdown as Record<number, number>)[1]++;
    else if (priority >= 20) (stats.tier_breakdown as Record<number, number>)[2]++;
    else (stats.tier_breakdown as Record<number, number>)[3]++;
  }

  // Recent tweets
  const oneHourAgo = new Date(Date.now() - 3600000).toISOString();
  const recent = await lancedbQuery(
    "nitter_posts",
    `timestamp >= '${oneHourAgo}'`,
    1000
  );
  stats.tweets_last_hour = recent.records.length;

  // Health check
  const health = await nitterHealth();
  stats.nitter_healthy = health.healthy;

  return json(stats);
}

// ---------------------------------------------------------------------------
// Social Graph Expansion
// ---------------------------------------------------------------------------

async function crawlerExpandGraph(
  args: Record<string, unknown>
): Promise<ToolResult> {
  const username = String(args.username ?? "")
    .toLowerCase()
    .replace(/^@/, "");
  const direction = String(args.direction ?? "both");
  const limit = Number(args.limit ?? 100);

  if (!username) {
    return json({ error: "username is required" });
  }

  const results: Record<string, unknown> = {
    username,
    direction,
    following: { fetched: 0, edges_added: 0, users_added: 0 },
    followers: { fetched: 0, edges_added: 0, users_added: 0 },
  };

  // Fetch following
  if (direction === "following" || direction === "both") {
    const followingResult = await nitterUserFollowing(username, limit);
    if (followingResult.error) {
      (results.following as Record<string, unknown>).error = followingResult.error;
    } else {
      const stats = await processFollowList(
        username,
        followingResult.users,
        "follows", // relationship_type
        "source"   // username is the source (they follow others)
      );
      results.following = { fetched: followingResult.users.length, ...stats };
    }
  }

  // Fetch followers
  if (direction === "followers" || direction === "both") {
    const followersResult = await nitterUserFollowers(username, limit);
    if (followersResult.error) {
      (results.followers as Record<string, unknown>).error = followersResult.error;
    } else {
      const stats = await processFollowList(
        username,
        followersResult.users,
        "follows", // relationship_type
        "target"   // username is the target (others follow them)
      );
      results.followers = { fetched: followersResult.users.length, ...stats };
    }
  }

  // Update the user's last_crawled timestamp
  await lancedbUpdateField(
    "nitter_users",
    `username = '${username}'`,
    "last_crawled",
    now()
  );

  return json(results);
}

/**
 * Process a list of follow users: add edges and discovered users
 */
async function processFollowList(
  mainUser: string,
  users: NitterFollowUser[],
  relationshipType: string,
  mainUserRole: "source" | "target"
): Promise<{ edges_added: number; users_added: number }> {
  let edgesAdded = 0;
  let usersAdded = 0;

  for (const followUser of users) {
    const targetUsername = followUser.username.toLowerCase().replace(/^@/, "");
    if (!targetUsername) continue;

    // Determine edge direction
    const sourceUser = mainUserRole === "source" ? mainUser : targetUsername;
    const targetUser = mainUserRole === "source" ? targetUsername : mainUser;
    const edgeHash = sha256(`${sourceUser}-follows-${targetUser}`);

    // Check if edge exists
    const existingEdge = await lancedbQuery(
      "nitter_follows",
      `edge_hash = '${edgeHash}'`,
      1
    );

    if (existingEdge.records.length === 0) {
      await lancedbIngest("nitter_follows", [
        {
          id: randomUUID(),
          source_user: sourceUser,
          target_user: targetUser,
          edge_hash: edgeHash,
          relationship_type: relationshipType,
          discovered_at: now(),
        },
      ]);
      edgesAdded++;
    }

    // Add user if not exists
    const existingUser = await lancedbQuery(
      "nitter_users",
      `username = '${targetUsername}'`,
      1
    );

    if (existingUser.records.length === 0) {
      await lancedbIngest("nitter_users", [
        {
          id: randomUUID(),
          username: targetUsername,
          display_name: followUser.fullname ?? "",
          bio: followUser.bio ?? "",
          category: "discovered",
          discovered_from: mainUser,
          discovery_method: "graph_expansion",
          crawl_priority: 10.0, // Higher than interaction-based discovery
          follower_estimate: 0,
          first_seen: now(),
          last_crawled: "",
          tags: [],
          embedding: await generateEmbedding(
            `${targetUsername} ${followUser.fullname ?? ""} ${followUser.bio ?? ""}`
          ),
        },
      ]);
      usersAdded++;
    }
  }

  return { edges_added: edgesAdded, users_added: usersAdded };
}

// ---------------------------------------------------------------------------
// Historical Backfill
// ---------------------------------------------------------------------------

async function crawlerBackfill(
  args: Record<string, unknown>
): Promise<ToolResult> {
  const limit = Number(args.limit ?? 5);
  const tweetsPerUser = Number(args.tweets_per_user ?? 100);
  const categoryFilter = args.category as string | undefined;

  // Find users with no posts
  const usersResult = await lancedbQuery("nitter_users", undefined, 10000);
  const allUsers = usersResult.records;

  // Get post counts per user
  const postsResult = await lancedbQuery("nitter_posts", undefined, 100000);
  const postsByUser = new Map<string, number>();
  for (const post of postsResult.records) {
    const username = (post as Record<string, unknown>).username as string;
    postsByUser.set(username, (postsByUser.get(username) ?? 0) + 1);
  }

  // Filter to users with 0 posts
  const usersToBackfill = allUsers
    .filter((u) => {
      const username = (u as Record<string, unknown>).username as string;
      const category = (u as Record<string, unknown>).category as string ?? "";
      const hasNoPosts = (postsByUser.get(username) ?? 0) === 0;
      const matchesCategory = !categoryFilter || category === categoryFilter;
      return hasNoPosts && matchesCategory;
    })
    .sort((a, b) => {
      // Prioritize seeds, then by crawl_priority
      const aIsSeed = (a as Record<string, unknown>).category === "seed" ? 1 : 0;
      const bIsSeed = (b as Record<string, unknown>).category === "seed" ? 1 : 0;
      if (aIsSeed !== bIsSeed) return bIsSeed - aIsSeed;
      return (
        ((b as Record<string, unknown>).crawl_priority as number ?? 0) -
        ((a as Record<string, unknown>).crawl_priority as number ?? 0)
      );
    })
    .slice(0, limit);

  const results: {
    username: string;
    tweets_fetched: number;
    tweets_stored: number;
    error?: string;
  }[] = [];

  for (const user of usersToBackfill) {
    const username = (user as Record<string, unknown>).username as string;
    console.log(`Backfilling @${username}...`);

    try {
      const tweets = await nitterUserTweets(username, tweetsPerUser);
      if (tweets.error) {
        results.push({ username, tweets_fetched: 0, tweets_stored: 0, error: tweets.error });
        continue;
      }

      let stored = 0;
      for (const tweet of tweets.tweets) {
        const tweetId = tweet.tweet_id ?? tweet.permalink?.split("/").pop() ?? "";
        if (!tweetId) continue;

        const contentHash = sha256(tweetId);

        // Dedup check
        const existing = await lancedbQuery(
          "nitter_posts",
          `content_hash = '${contentHash}'`,
          1
        );
        if (existing.records.length > 0) continue;

        // Store tweet
        const record: LanceDBRecord = {
          id: randomUUID(),
          tweet_id: tweetId,
          username,
          text: tweet.text ?? "",
          pub_date: tweet.pub_date ?? tweet.timestamp ?? "",
          permalink: tweet.permalink ?? tweet.url ?? "",
          mentions: tweet.mentions ?? [],
          hashtags: tweet.hashtags ?? [],
          quoted_user: tweet.quoted_user ?? "",
          reply_to_user: tweet.reply_to_user ?? tweet.reply_to ?? "",
          source_query: `backfill:${username}`,
          content_hash: contentHash,
          timestamp: now(),
          embedding: await generateEmbedding(tweet.text ?? ""),
          media_urls: tweet.media_urls ?? tweet.media ?? [],
          entities: [],
          key_topics: [],
        };

        await lancedbIngest("nitter_posts", [record]);
        stored++;
      }

      // Mark user as backfilled
      await lancedbUpdateField("nitter_users", "username", username, {
        last_crawled: now(),
      });

      results.push({
        username,
        tweets_fetched: tweets.tweets.length,
        tweets_stored: stored,
      });

      await delay(1000); // Rate limit between users
    } catch (err) {
      results.push({
        username,
        tweets_fetched: 0,
        tweets_stored: 0,
        error: String(err),
      });
    }
  }

  const totalFetched = results.reduce((sum, r) => sum + r.tweets_fetched, 0);
  const totalStored = results.reduce((sum, r) => sum + r.tweets_stored, 0);

  return json({
    users_backfilled: results.length,
    total_tweets_fetched: totalFetched,
    total_tweets_stored: totalStored,
    details: results,
  });
}

async function crawlerRunCycle(): Promise<ToolResult> {
  const results: Record<string, unknown> = {};

  // 1. Update priorities
  const prioritiesResult = await crawlerUpdatePriorities();
  results.priorities = JSON.parse(prioritiesResult.content[0]!.text);

  // 2. Graph expansion for seed users (run less frequently - daily)
  const oneDayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  const usersResult = await lancedbQuery("nitter_users", undefined, 10000);
  const users = usersResult.records;
  
  const seedsDueForGraphExpansion = users.filter((u) => {
    const category = (u as Record<string, unknown>).category as string ?? "";
    const lastCrawled = (u as Record<string, unknown>).last_crawled as string ?? "";
    return category === "seed" && (!lastCrawled || lastCrawled < oneDayAgo);
  });

  if (seedsDueForGraphExpansion.length > 0) {
    results.graph_expansion = [];
    // Limit to 1 seed per cycle to avoid rate limits
    const seed = seedsDueForGraphExpansion[0] as Record<string, unknown>;
    const username = seed.username as string;
    console.log(`Graph expansion for seed: @${username}`);
    
    const expandResult = await crawlerExpandGraph({
      username,
      direction: "both",
      limit: 100,
    });
    (results.graph_expansion as unknown[]).push({
      username,
      ...JSON.parse(expandResult.content[0]!.text),
    });
  }

  // 2.5. Backfill users with no posts (1 user per cycle)
  const backfillResult = await crawlerBackfill({
    limit: 1,
    tweets_per_user: 100,
    category: "seed", // Prioritize seeds first
  });
  const backfillData = JSON.parse(backfillResult.content[0]!.text);
  if (backfillData.users_backfilled > 0) {
    results.backfill = backfillData;
  }

  // 3. Collect tweets by tier based on staleness
  const nowTime = new Date();
  const intervals = {
    1: 5 * 60 * 1000, // 5 min
    2: 15 * 60 * 1000, // 15 min
    3: 60 * 60 * 1000, // 1 hour
  };

  for (const [tierStr, intervalMs] of Object.entries(intervals)) {
    const tier = Number(tierStr);
    const cutoff = new Date(nowTime.getTime() - intervalMs).toISOString();
    const [lo, hi] = { 1: [50, 999999], 2: [20, 50], 3: [0, 20] }[tier] ?? [
      0, 999999,
    ];

    const dueUsers = users.filter((u) => {
      const priority = (u as Record<string, unknown>).crawl_priority as number ?? 0;
      const lastCrawled = (u as Record<string, unknown>).last_crawled as string ?? "";
      return (
        priority >= lo &&
        priority < hi &&
        (!lastCrawled || lastCrawled < cutoff)
      );
    });

    if (dueUsers.length > 0) {
      const tierResult = await crawlerCollectTweets({
        tier,
        limit: dueUsers.length,
      });
      results[`tier${tier}`] = JSON.parse(tierResult.content[0]!.text);
    }
  }

  return json(results);
}

// ---------------------------------------------------------------------------
// Tool Dispatcher
// ---------------------------------------------------------------------------

function json(data: unknown): ToolResult {
  return {
    content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
  };
}

export async function handleCrawlerTool(
  name: string,
  args: Record<string, unknown>
): Promise<ToolResult> {
  switch (name) {
    case "crawler_add_seed":
      return crawlerAddSeed(args);
    case "crawler_discover":
      return crawlerDiscover(args);
    case "crawler_crawl_following":
      return crawlerCrawlFollowing(args);
    case "crawler_collect_tweets":
      return crawlerCollectTweets(args);
    case "crawler_update_priorities":
      return crawlerUpdatePriorities();
    case "crawler_query_tweets":
      return crawlerQueryTweets(args);
    case "crawler_query_graph":
      return crawlerQueryGraph(args);
    case "crawler_stats":
      return crawlerStats();
    case "crawler_run_cycle":
      return crawlerRunCycle();
    case "crawler_expand_graph":
      return crawlerExpandGraph(args);
    case "crawler_backfill":
      return crawlerBackfill(args);
    default:
      throw new Error(`Unknown crawler tool: ${name}`);
  }
}

/**
 * Check if a tool name is a crawler tool
 */
export function isCrawlerTool(name: string): boolean {
  return name.startsWith("crawler_");
}
