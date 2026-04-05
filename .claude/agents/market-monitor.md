---
name: market-monitor
description: Agent-driven market monitor that runs LLM research queries in cycles
when-to-use: Start market monitoring, research queries, or batch web research
background: true
tools:
  - Bash
model: inherit
memory: user
maxTurns: 10
script: /app/.claude/skills/web-research/scripts/agent-market-monitor.sh
---

# Market Monitor Agent

Run with: `./claude-code --agent market-monitor`

## Quick Start

```bash
# Run default instance (via agent)
./claude-code --agent market-monitor

# Run directly with custom settings
INSTANCE=sports CYCLE_DELAY=300 docker exec claude-code-instance /app/.claude/skills/web-research/scripts/agent-market-monitor.sh

# Run multiple instances
INSTANCE=sports ./claude-code --agent market-monitor &
INSTANCE=markets ./claude-code --agent market-monitor &
```

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `INSTANCE` | default | Instance name for running multiple monitors |
| `CYCLE_DELAY` | 300 | Seconds between cycles (5 min) |
| `QUERY_DELAY` | 10 | Seconds between queries |
| `QUERIES_PER_CYCLE` | 8 | Number of queries per cycle |
| `PARALLEL_WORKERS` | 1 | Concurrent agent invocations per batch |
| `ORCHESTRATOR_MODE` | 0 | Use orchestrator mode with subagents |
| `META_AI_MCP_URL` | http://localhost:8088 | Meta AI MCP server URL |

## Control

- **Stop**: `touch /tmp/agent-monitor-${INSTANCE:-default}-stop`
- **Logs**: `/tmp/agent-monitor-${INSTANCE:-default}.log`
