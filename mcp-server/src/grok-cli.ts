#!/usr/bin/env bun
/**
 * Grok CLI — TypeScript wrapper for Grok MCP tools
 * 
 * Usage:
 *   bun grok-cli.ts rephrase "US stock market today"
 *   bun grok-cli.ts batch '["query1", "query2"]'
 *   bun grok-cli.ts trending finance
 *   bun grok-cli.ts chat "What's happening in markets?"
 *   bun grok-cli.ts chat --search "Breaking news on Tesla"
 *   bun grok-cli.ts rate-limit              # Show rate limit status
 */

import {
  grokChat,
  grokRephraseQuery,
  grokBatchRephrase,
  grokTrendingTopics,
  grokAnalyzeTweets,
  getGrokRateLimitState,
  isGrokAvailable,
} from "./nitter-client.js";

const [command, ...args] = process.argv.slice(2);

async function main() {
  switch (command) {
    case "rephrase": {
      const query = args[0];
      if (!query) {
        console.error("Usage: grok-cli.ts rephrase <query>");
        process.exit(1);
      }
      const result = await grokRephraseQuery(query);
      if (result.error) {
        console.error("Error:", result.error);
        process.exit(1);
      }
      console.log(result.alternative);
      break;
    }

    case "batch": {
      const jsonArg = args[0];
      if (!jsonArg) {
        console.error("Usage: grok-cli.ts batch '<json array of queries>'");
        process.exit(1);
      }
      let queries: string[];
      try {
        queries = JSON.parse(jsonArg);
      } catch {
        console.error("Invalid JSON array");
        process.exit(1);
      }
      const result = await grokBatchRephrase(queries, { queueIfRateLimited: true });
      if (result.error) {
        console.error("Error:", result.error);
        if (result.queued?.length) {
          console.error("Queued for later:", result.queued.length, "queries");
        }
      }
      console.log(JSON.stringify(result.alternatives, null, 2));
      
      // Print rate limit info
      if (result.rateLimit) {
        console.error("\nRate limit state:");
        console.error(`  Total calls: ${result.rateLimit.totalCalls}`);
        console.error(`  Rate limit hits: ${result.rateLimit.rateLimitHits}`);
        console.error(`  Is limited: ${result.rateLimit.isRateLimited}`);
        if (result.rateLimit.estimatedResetSecs) {
          console.error(`  Reset in: ${Math.ceil(result.rateLimit.estimatedResetSecs / 60)}min`);
        }
      }
      break;
    }

    case "trending": {
      const category = args[0] || "finance";
      const result = await grokTrendingTopics(category);
      if (result.error) {
        console.error("Error:", result.error);
        process.exit(1);
      }
      console.log("Trending topics:");
      result.topics.forEach((t, i) => console.log(`  ${i + 1}. ${t}`));
      break;
    }

    case "chat": {
      const hasSearch = args.includes("--search");
      const message = args.filter(a => a !== "--search").join(" ");
      if (!message) {
        console.error("Usage: grok-cli.ts chat [--search] <message>");
        process.exit(1);
      }
      const result = await grokChat(message, { includeSearch: hasSearch });
      if (result.error) {
        console.error("Error:", result.error);
        process.exit(1);
      }
      console.log(result.response);
      
      // Print rate limit info
      if (result.rateLimit) {
        console.error(`\nRate limit: ${result.rateLimit.recentCalls.length}/20 calls in window`);
        if (result.rateLimit.isRateLimited) {
          console.error(`Rate limited! Reset in ${Math.ceil((result.rateLimit.estimatedResetSecs || 0) / 60)}min`);
        }
      }
      break;
    }

    case "rate-limit":
    case "ratelimit":
    case "status": {
      const state = getGrokRateLimitState();
      console.log("Grok Rate Limit Status:");
      console.log("========================");
      console.log(`Available: ${isGrokAvailable() ? "YES" : "NO"}`);
      console.log(`Calls in window: ${state.recentCalls.length}/20`);
      console.log(`Total calls (session): ${state.totalCalls}`);
      console.log(`Rate limit hits: ${state.rateLimitHits}`);
      console.log(`Queued queries: ${state.queuedQueries.length}`);
      if (state.estimatedResetSecs) {
        console.log(`Reset in: ${Math.ceil(state.estimatedResetSecs / 60)} minutes`);
      }
      if (state.lastRateLimitError) {
        console.log(`Last error: ${state.lastRateLimitError.substring(0, 100)}...`);
      }
      break;
    }

    case "analyze": {
      // Read tweets from stdin as JSON array
      const input = await Bun.stdin.text();
      let data: { tweets: string[]; question: string };
      try {
        data = JSON.parse(input);
      } catch {
        console.error('Usage: echo \'{"tweets":["t1","t2"], "question":"sentiment?"}\' | grok-cli.ts analyze');
        process.exit(1);
      }
      const result = await grokAnalyzeTweets(data.tweets, data.question);
      if (result.error) {
        console.error("Error:", result.error);
        process.exit(1);
      }
      console.log(result.analysis);
      break;
    }

    default:
      console.log(`Grok CLI — TypeScript MCP wrapper with rate limit tracking

Commands:
  rephrase <query>           Suggest alternative search query
  batch '<json array>'       Batch rephrase multiple queries (1 API call)
  trending [category]        Get trending topics (default: finance)
  chat [--search] <message>  Chat with Grok (--search enables web/X search)
  analyze                    Analyze tweets (read JSON from stdin)
  rate-limit                 Show current rate limit status

Rate Limiting:
  Grok has ~20 requests per 2 hours for free tier.
  The CLI tracks calls and shows remaining quota.

Examples:
  bun grok-cli.ts rephrase "US stock market today"
  bun grok-cli.ts batch '["query1", "query2", "query3"]'
  bun grok-cli.ts chat --search "What's happening with Tesla today?"
  bun grok-cli.ts rate-limit
`);
      process.exit(command ? 1 : 0);
  }
}

main().catch((err) => {
  console.error("Fatal:", err.message);
  process.exit(1);
});
