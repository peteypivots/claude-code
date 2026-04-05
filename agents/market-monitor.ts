/**
 * Market Monitor Agent
 * 
 * Continuous agent for market research monitoring.
 * Spawns the agent-market-monitor.sh script in the background.
 * 
 * Start via:
 *   docker exec claude-code-instance bash /app/.claude/skills/web-research/scripts/agent-market-monitor.sh
 *   
 * Or as a daemon task in docker-compose.yml
 */

// This file is a placeholder for future direct CLI integration.
// For now, use bash script invocation via docker exec

export const name = 'market-monitor';
export const description = 'Continuous market research monitoring agent';

export async function main() {
  console.log('Market Monitor Agent');
  console.log('');
  console.log('Start the monitor with:');
  console.log('  docker exec -d claude-code-instance bash /app/.claude/skills/web-research/scripts/agent-market-monitor.sh');
  console.log('');
  console.log('View logs with:');
  console.log('  docker exec claude-code-instance tail -f /tmp/agent-monitor-default.log');
  console.log('');
  console.log('Stop the monitor with:');
  console.log('  docker exec claude-code-instance touch /tmp/agent-monitor-default-stop');
  console.log('');
  console.log('Configuration:');
  console.log('  INSTANCE=name           - Run multiple named instances');
  console.log('  ORCHESTRATOR_MODE=1     - Use orchestrator for parallel research');
  console.log('  PARALLEL_WORKERS=N      - Run N queries in parallel');
  console.log('  CYCLE_DELAY=SECONDS     - Delay between cycles (default: 300)');
  console.log('  QUERY_DELAY=SECONDS     - Delay between queries (default: 10)');
}
