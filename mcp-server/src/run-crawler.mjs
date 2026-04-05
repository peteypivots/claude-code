#!/usr/bin/env node
/**
 * Nitter Crawler Runner
 * Runs continuous crawl cycles using the MCP crawler tools
 * 
 * Usage:
 *   node run-crawler.mjs                    # Run forever
 *   node run-crawler.mjs --cycles 5         # Run 5 cycles
 *   node run-crawler.mjs --delay 300        # 5 min between cycles
 */

import { handleCrawlerTool } from "./crawler.js";

const args = process.argv.slice(2);
const getArg = (name, def) => {
  const idx = args.indexOf(`--${name}`);
  return idx >= 0 && args[idx + 1] ? args[idx + 1] : def;
};

const MAX_CYCLES = parseInt(getArg("cycles", "0"), 10); // 0 = infinite
const CYCLE_DELAY_SEC = parseInt(getArg("delay", "120"), 10);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function runCycle(cycleNum) {
  console.log(`\n=== Cycle ${cycleNum} @ ${new Date().toISOString()} ===`);

  try {
    // 1. Update priorities
    console.log("Updating priorities...");
    const priorities = await handleCrawlerTool("crawler_update_priorities", {});
    console.log(priorities.content[0].text);

    // 2. Run collection cycle
    console.log("\nRunning crawl cycle...");
    const cycle = await handleCrawlerTool("crawler_run_cycle", {});
    console.log(cycle.content[0].text);

    // 3. Stats
    console.log("\nStats:");
    const stats = await handleCrawlerTool("crawler_stats", {});
    console.log(stats.content[0].text);

  } catch (err) {
    console.error("Cycle error:", err.message);
  }
}

async function main() {
  console.log("Nitter Crawler Starting");
  console.log(`  Cycles: ${MAX_CYCLES || "infinite"}`);
  console.log(`  Delay: ${CYCLE_DELAY_SEC}s between cycles`);

  let cycle = 1;
  while (MAX_CYCLES === 0 || cycle <= MAX_CYCLES) {
    await runCycle(cycle);
    
    if (MAX_CYCLES > 0 && cycle >= MAX_CYCLES) break;
    
    console.log(`\nSleeping ${CYCLE_DELAY_SEC}s...`);
    await sleep(CYCLE_DELAY_SEC * 1000);
    cycle++;
  }

  console.log("\nCrawler finished.");
}

main().catch(console.error);
