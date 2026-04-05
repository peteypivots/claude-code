/**
 * Nitter MCP JSON-RPC client
 *
 * Communicates with nitter-mcp server to fetch tweets and user info.
 *
 * Environment:
 *   NITTER_MCP_URL    - MCP server URL (default: http://172.23.0.1:8085)
 *   MCP_HOST_HEADER   - Host header override (default: localhost:8085)
 */

const NITTER_MCP_URL = process.env.NITTER_MCP_URL ?? "http://172.23.0.1:8085";
const MCP_HOST_HEADER = process.env.MCP_HOST_HEADER ?? "localhost:8085";

interface MCPResponse {
  result?: {
    content?: { text?: string; type: string }[];
    structuredContent?: unknown;
  };
  error?: { code: number; message: string };
}

/**
 * Low-level MCP tool call
 */
async function mcpCall(
  toolName: string,
  args: Record<string, unknown>
): Promise<unknown> {
  // Step 1: Initialize session
  const initResp = await fetch(NITTER_MCP_URL, {
    method: "POST",
    headers: {
      Host: MCP_HOST_HEADER,
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-03-26",
        capabilities: {},
        clientInfo: { name: "nitter-crawler-ts", version: "1.0" },
      },
    }),
  });

  const sessionId = initResp.headers.get("mcp-session-id");
  if (!sessionId) {
    throw new Error("No MCP session ID returned");
  }

  // Step 2: Send initialized notification
  await fetch(NITTER_MCP_URL, {
    method: "POST",
    headers: {
      Host: MCP_HOST_HEADER,
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      "Mcp-Session-Id": sessionId,
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      method: "notifications/initialized",
    }),
  });

  // Step 3: Call tool
  const resp = await fetch(NITTER_MCP_URL, {
    method: "POST",
    headers: {
      Host: MCP_HOST_HEADER,
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      "Mcp-Session-Id": sessionId,
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: { name: toolName, arguments: args },
    }),
  });

  // Parse SSE response
  const text = await resp.text();
  const lines = text.split("\n");
  const dataLines = lines.filter((l) => l.startsWith("data: "));
  if (!dataLines.length) {
    throw new Error("No data in MCP response");
  }

  const lastData = dataLines[dataLines.length - 1]!.slice(6);
  const parsed: MCPResponse = JSON.parse(lastData);

  if (parsed.error) {
    throw new Error(`MCP error: ${parsed.error.message}`);
  }

  // Return structured content or text content
  if (parsed.result?.structuredContent) {
    return parsed.result.structuredContent;
  }
  if (parsed.result?.content?.[0]?.text) {
    try {
      return JSON.parse(parsed.result.content[0].text);
    } catch {
      return parsed.result.content[0].text;
    }
  }

  return parsed.result;
}

export interface NitterTweet {
  tweet_id: string;
  username: string;
  text: string;
  pub_date?: string;
  timestamp?: string;
  permalink?: string;
  url?: string;
  mentions?: string[];
  hashtags?: string[];
  quoted_user?: string;
  reply_to?: string;
  reply_to_user?: string;
  likes?: number;
  retweets?: number;
  media?: string[];
  media_urls?: string[];
}

export interface NitterUser {
  username: string;
  name?: string;
  bio?: string;
  followers?: number;
  following?: number;
  tweets?: number;
  verified?: boolean;
}

export interface NitterSearchResult {
  tweets: NitterTweet[];
  error?: string;
}

export interface NitterUserResult {
  user?: NitterUser;
  error?: string;
}

export interface NitterTimelineResult {
  tweets: NitterTweet[];
  error?: string;
}

/**
 * Search tweets by keyword
 */
export async function nitterSearchTweets(
  query: string,
  limit = 20
): Promise<NitterSearchResult> {
  try {
    const result = await mcpCall("nitter_search_tweets", { query, limit });
    if (Array.isArray(result)) {
      return { tweets: result };
    }
    const data = result as Record<string, unknown>;
    return { tweets: (data.tweets ?? data.results ?? []) as NitterTweet[] };
  } catch (err) {
    return { tweets: [], error: String(err) };
  }
}

/**
 * Get user profile
 */
export async function nitterUserProfile(
  username: string
): Promise<NitterUserResult> {
  try {
    const result = await mcpCall("nitter_user_tweets", { username, limit: 1 });
    // The user info is often embedded in tweet results or we need a separate call
    // For now, extract from first tweet if available
    const data = result as Record<string, unknown>;
    if (data.user) {
      return { user: data.user as NitterUser };
    }
    // Fallback: construct minimal user info
    return {
      user: {
        username: username.toLowerCase(),
        followers: (data.followers as number) ?? 0,
      },
    };
  } catch (err) {
    return { error: String(err) };
  }
}

/**
 * Get user's recent tweets
 */
export async function nitterUserTweets(
  username: string,
  limit = 20
): Promise<NitterTimelineResult> {
  try {
    const result = await mcpCall("nitter_user_tweets", { username, limit });
    if (Array.isArray(result)) {
      return { tweets: result };
    }
    const data = result as Record<string, unknown>;
    return { tweets: (data.tweets ?? data.results ?? []) as NitterTweet[] };
  } catch (err) {
    return { tweets: [], error: String(err) };
  }
}

/**
 * Search users (advanced search with from_user filter)
 */
export async function nitterSearchUsers(
  query: string,
  limit = 20
): Promise<{ users: NitterUser[]; error?: string }> {
  try {
    // Use advanced search to find users mentioning this query
    const result = await mcpCall("nitter_advanced_search", {
      query,
      limit,
    });
    const data = result as Record<string, unknown>;

    // Extract unique users from results
    const tweets = (data.tweets ?? data.results ?? []) as NitterTweet[];
    const userMap = new Map<string, NitterUser>();

    for (const tweet of tweets) {
      // nitter_advanced_search returns 'creator' like '@username'
      // biome-ignore lint: flexible type access for varying API responses
      const rawUser = tweet.username ?? (tweet as unknown as Record<string, unknown>).creator;
      if (!rawUser) continue;
      const username = String(rawUser).replace(/^@/, "").toLowerCase();
      if (!userMap.has(username)) {
        userMap.set(username, {
          username,
          name: username,
          followers: 0,
        });
      }
    }

    return { users: Array.from(userMap.values()) };
  } catch (err) {
    return { users: [], error: String(err) };
  }
}

/**
 * Check nitter MCP health
 */
export async function nitterHealth(): Promise<{
  healthy: boolean;
  error?: string;
}> {
  try {
    await mcpCall("nitter_health", {});
    return { healthy: true };
  } catch (err) {
    return { healthy: false, error: String(err) };
  }
}

// ---------------------------------------------------------------------------
// Social Graph Endpoints
// ---------------------------------------------------------------------------

export interface NitterFollowUser {
  username: string;
  fullname?: string;
  bio?: string;
  profile_url?: string;
}

export interface NitterFollowResult {
  username: string;
  count: number;
  users: NitterFollowUser[];
  error?: string;
}

/**
 * Get accounts a user is following
 */
export async function nitterUserFollowing(
  username: string,
  limit = 100
): Promise<NitterFollowResult> {
  try {
    const result = await mcpCall("nitter_user_following", { username, limit });
    const data = result as Record<string, unknown>;
    
    // Handle both array and object response formats
    let users: NitterFollowUser[] = [];
    if (Array.isArray(data.following)) {
      users = data.following as NitterFollowUser[];
    } else if (Array.isArray(result)) {
      users = result as NitterFollowUser[];
    }

    return {
      username: username.toLowerCase(),
      count: (data.count as number) ?? users.length,
      users,
    };
  } catch (err) {
    return { username: username.toLowerCase(), count: 0, users: [], error: String(err) };
  }
}

/**
 * Get accounts following a user
 */
export async function nitterUserFollowers(
  username: string,
  limit = 100
): Promise<NitterFollowResult> {
  try {
    const result = await mcpCall("nitter_user_followers", { username, limit });
    const data = result as Record<string, unknown>;
    
    // Handle both array and object response formats
    let users: NitterFollowUser[] = [];
    if (Array.isArray(data.followers)) {
      users = data.followers as NitterFollowUser[];
    } else if (Array.isArray(result)) {
      users = result as NitterFollowUser[];
    }

    return {
      username: username.toLowerCase(),
      count: (data.count as number) ?? users.length,
      users,
    };
  } catch (err) {
    return { username: username.toLowerCase(), count: 0, users: [], error: String(err) };
  }
}

/**
 * Get user's highlighted/pinned tweets
 */
export async function nitterUserHighlights(
  username: string
): Promise<NitterTimelineResult> {
  try {
    const result = await mcpCall("nitter_user_highlights", { username });
    if (Array.isArray(result)) {
      return { tweets: result as NitterTweet[] };
    }
    const data = result as Record<string, unknown>;
    return { tweets: (data.tweets ?? data.highlights ?? []) as NitterTweet[] };
  } catch (err) {
    return { tweets: [], error: String(err) };
  }
}

export interface AdvancedSearchParams {
  query: string;
  limit?: number;
  min_faves?: number;
  min_retweets?: number;
  since?: string;  // YYYY-MM-DD
  until?: string;  // YYYY-MM-DD
  filter?: "media" | "images" | "videos" | "links" | "replies" | "nativeretweets";
}

/**
 * Advanced search with filters (min_faves, date range, media type)
 */
export async function nitterAdvancedSearch(
  params: AdvancedSearchParams
): Promise<NitterSearchResult> {
  try {
    const result = await mcpCall("nitter_advanced_search", params);
    if (Array.isArray(result)) {
      return { tweets: result as NitterTweet[] };
    }
    const data = result as Record<string, unknown>;
    return { tweets: (data.tweets ?? data.results ?? []) as NitterTweet[] };
  } catch (err) {
    return { tweets: [], error: String(err) };
  }
}

// ---------------------------------------------------------------------------
// Grok AI Endpoints - with Rate Limit Tracking
// ---------------------------------------------------------------------------

/**
 * Rate limit tracking state.
 * Grok has ~20 requests per 2 hours for free tier.
 */
export interface GrokRateLimitState {
  /** Timestamps of recent Grok calls (for sliding window) */
  recentCalls: number[];
  /** Total calls made this session */
  totalCalls: number;
  /** Calls that hit rate limit */
  rateLimitHits: number;
  /** Last rate limit error message */
  lastRateLimitError?: string;
  /** Queued queries waiting for rate limit to reset */
  queuedQueries: string[];
  /** Whether rate limit is currently active */
  isRateLimited: boolean;
  /** Estimated time until rate limit resets (seconds) */
  estimatedResetSecs?: number;
}

// Global rate limit state (persists across calls)
const grokRateLimit: GrokRateLimitState = {
  recentCalls: [],
  totalCalls: 0,
  rateLimitHits: 0,
  queuedQueries: [],
  isRateLimited: false,
};

// Rate limit constants
const RATE_LIMIT_WINDOW_MS = 2 * 60 * 60 * 1000; // 2 hours in ms
const RATE_LIMIT_MAX_CALLS = 20;

/**
 * Get current Grok rate limit state
 */
export function getGrokRateLimitState(): GrokRateLimitState {
  // Clean up old calls outside the window
  const now = Date.now();
  grokRateLimit.recentCalls = grokRateLimit.recentCalls.filter(
    t => now - t < RATE_LIMIT_WINDOW_MS
  );
  
  // Estimate reset time based on oldest call in window
  if (grokRateLimit.recentCalls.length >= RATE_LIMIT_MAX_CALLS) {
    const oldest = grokRateLimit.recentCalls[0];
    if (oldest) {
      grokRateLimit.estimatedResetSecs = Math.ceil(
        (RATE_LIMIT_WINDOW_MS - (now - oldest)) / 1000
      );
    }
  } else {
    grokRateLimit.estimatedResetSecs = undefined;
  }
  
  return { ...grokRateLimit };
}

/**
 * Check if Grok is available (not rate limited)
 */
export function isGrokAvailable(): boolean {
  const state = getGrokRateLimitState();
  return state.recentCalls.length < RATE_LIMIT_MAX_CALLS;
}

/**
 * Queue a query for later processing when rate limit resets
 */
export function queueGrokQuery(query: string): void {
  if (!grokRateLimit.queuedQueries.includes(query)) {
    grokRateLimit.queuedQueries.push(query);
  }
}

/**
 * Get and clear queued queries
 */
export function getAndClearQueuedQueries(): string[] {
  const queries = [...grokRateLimit.queuedQueries];
  grokRateLimit.queuedQueries = [];
  return queries;
}

// Track call for rate limiting
function trackGrokCall(hitRateLimit: boolean, error?: string): void {
  grokRateLimit.totalCalls++;
  if (hitRateLimit) {
    grokRateLimit.rateLimitHits++;
    grokRateLimit.isRateLimited = true;
    grokRateLimit.lastRateLimitError = error;
  } else {
    grokRateLimit.recentCalls.push(Date.now());
    grokRateLimit.isRateLimited = false;
  }
}

export interface GrokChatResult {
  response: string;
  conversationId?: string;
  citations?: unknown[];
  searchResults?: unknown[];
  /** Whether this call hit rate limit */
  rateLimited?: boolean;
  /** Current rate limit state */
  rateLimit?: GrokRateLimitState;
  error?: string;
}

export interface GrokBatchRephraseResult {
  alternatives: Record<string, string>;  // original -> alternative mapping
  /** Queries that couldn't be processed (rate limited) */
  queued?: string[];
  /** Current rate limit state */
  rateLimit?: GrokRateLimitState;
  error?: string;
}

/**
 * Chat with Grok AI
 * 
 * Includes automatic rate limit tracking and reporting.
 * 
 * @param message - The message to send
 * @param options.includeSearch - Enable web/X search (slower, ~5-8s vs ~2s)
 * @param options.includeCitations - Include citation sources
 * @param options.model - Model to use (default: grok-3-latest)
 * @param options.skipIfRateLimited - Return early if already rate limited
 */
export async function grokChat(
  message: string,
  options: {
    includeSearch?: boolean;
    includeCitations?: boolean;
    model?: string;
    skipIfRateLimited?: boolean;
  } = {}
): Promise<GrokChatResult> {
  // Check if we should skip due to rate limit
  if (options.skipIfRateLimited && !isGrokAvailable()) {
    return {
      response: "",
      rateLimited: true,
      rateLimit: getGrokRateLimitState(),
      error: "Rate limited - skipped",
    };
  }

  const startTime = Date.now();
  
  try {
    const result = await mcpCall("grok_chat", {
      message,
      model: options.model ?? "grok-3-latest",
      include_search: options.includeSearch ?? false,
      include_citations: options.includeCitations ?? false,
    });

    const data = result as Record<string, unknown>;
    const response = (data.response as string) ?? "";
    
    // Check for rate limit error in response
    const isRateLimited = response.toLowerCase().includes("reached your limit") ||
                          response.toLowerCase().includes("rate limit");
    
    // Track this call
    trackGrokCall(isRateLimited, isRateLimited ? response : undefined);
    
    return {
      response: isRateLimited ? "" : response,
      conversationId: data.conversation_id as string | undefined,
      citations: data.citations as unknown[] | undefined,
      searchResults: data.search_results as unknown[] | undefined,
      rateLimited: isRateLimited,
      rateLimit: getGrokRateLimitState(),
    };
  } catch (err) {
    const errorMsg = String(err);
    const isRateLimited = errorMsg.toLowerCase().includes("rate limit");
    trackGrokCall(isRateLimited, errorMsg);
    
    return {
      response: "",
      rateLimited: isRateLimited,
      rateLimit: getGrokRateLimitState(),
      error: errorMsg,
    };
  }
}

/**
 * Rephrase a single query using Grok
 * 
 * Returns an alternative search query for finding fresh content.
 */
export async function grokRephraseQuery(
  query: string,
  context?: string
): Promise<{ alternative: string; error?: string }> {
  const prompt = `I've been searching for: "${query}"

But I'm getting duplicate results I've already seen. Suggest ONE alternative search query that would:
1. Cover the same topic from a different angle
2. Use different keywords to find fresh content
3. Be specific enough to avoid SEO spam

${context ? `Context: ${context}` : ""}

Reply with ONLY the search query, no explanation. Maximum 10 words.`;

  const result = await grokChat(prompt);
  if (result.error) {
    return { alternative: "", error: result.error };
  }

  // Clean up response - remove quotes, trim
  const alt = result.response.replace(/^["']|["']$/g, "").trim();
  return { alternative: alt };
}

/**
 * Batch rephrase multiple queries in ONE Grok API call
 * 
 * Much more efficient than calling grokRephraseQuery multiple times:
 * - Single API call = single rate limit hit
 * - ~2-3 seconds total regardless of query count
 * 
 * @param queries - Array of queries to rephrase
 * @param options.queueIfRateLimited - Queue queries for later if rate limited
 * @returns Mapping of original query -> alternative query
 */
export async function grokBatchRephrase(
  queries: string[],
  options: { queueIfRateLimited?: boolean } = {}
): Promise<GrokBatchRephraseResult> {
  if (queries.length === 0) {
    return { alternatives: {}, rateLimit: getGrokRateLimitState() };
  }

  // Check rate limit before making call
  if (!isGrokAvailable()) {
    if (options.queueIfRateLimited) {
      queries.forEach(q => queueGrokQuery(q));
    }
    return {
      alternatives: {},
      queued: options.queueIfRateLimited ? queries : undefined,
      rateLimit: getGrokRateLimitState(),
      error: "Rate limited - queries queued for later",
    };
  }

  // Build numbered list for prompt
  const queryList = queries
    .map((q, i) => `${i + 1}. "${q}"`)
    .join("\n");

  const prompt = `These search queries returned duplicate results. For each, suggest ONE alternative query.

${queryList}

Reply ONLY with valid JSON mapping each original to its alternative:
{"original query 1": "alternative 1", "original query 2": "alternative 2"}`;

  const result = await grokChat(prompt);
  
  // If rate limited, queue queries
  if (result.rateLimited) {
    if (options.queueIfRateLimited) {
      queries.forEach(q => queueGrokQuery(q));
    }
    return {
      alternatives: {},
      queued: options.queueIfRateLimited ? queries : undefined,
      rateLimit: result.rateLimit,
      error: result.error || "Rate limited",
    };
  }
  
  if (result.error) {
    return { alternatives: {}, rateLimit: result.rateLimit, error: result.error };
  }

  // Parse JSON from response
  try {
    // Handle markdown code blocks
    let jsonStr = result.response;
    if (jsonStr.includes("```json")) {
      jsonStr = jsonStr.replace(/```json\s*/g, "").replace(/```/g, "");
    }
    // Extract JSON object
    const match = jsonStr.match(/\{[^}]+\}/);
    if (match) {
      const parsed = JSON.parse(match[0]);
      return { alternatives: parsed as Record<string, string>, rateLimit: result.rateLimit };
    }
    // Try parsing whole response
    const parsed = JSON.parse(jsonStr);
    return { alternatives: parsed as Record<string, string>, rateLimit: result.rateLimit };
  } catch {
    return { alternatives: {}, rateLimit: result.rateLimit, error: `Failed to parse Grok response: ${result.response}` };
  }
}

/**
 * Ask Grok about trending topics on X/Twitter
 * 
 * Uses Grok's built-in X search capability (requires includeSearch: true)
 */
export async function grokTrendingTopics(
  category: string = "finance"
): Promise<{ topics: string[]; raw: string; error?: string }> {
  const result = await grokChat(
    `What are the 5 hottest topics people are discussing on Twitter/X about ${category} right now? List them briefly.`,
    { includeSearch: true }
  );

  if (result.error) {
    return { topics: [], raw: "", error: result.error };
  }

  // Extract numbered topics from response
  const lines = result.response.split("\n");
  const topics = lines
    .filter(l => /^\d+\./.test(l.trim()))
    .map(l => l.replace(/^\d+\.\s*\*?\*?/, "").replace(/\*?\*?$/, "").trim())
    .filter(Boolean);

  return { topics, raw: result.response };
}

/**
 * Analyze tweets with Grok
 * 
 * @param tweets - Array of tweet texts to analyze
 * @param question - Analysis question (e.g., "What's the sentiment?")
 */
export async function grokAnalyzeTweets(
  tweets: string[],
  question: string
): Promise<{ analysis: string; error?: string }> {
  if (tweets.length === 0) {
    return { analysis: "", error: "No tweets provided" };
  }

  const tweetList = tweets
    .slice(0, 20) // Limit to avoid context overflow
    .map((t, i) => `${i + 1}. ${t}`)
    .join("\n");

  const prompt = `Here are some tweets:

${tweetList}

${question}

Be concise in your response.`;

  const result = await grokChat(prompt);
  return { analysis: result.response, error: result.error };
}
