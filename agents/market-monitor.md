---
name: Market Monitor
description: Runs the market research monitoring script
when-to-use: Start continuous market research data collection
background: true
tools:
  - Bash
model: inherit
memory: user
maxTurns: 5
initialPrompt: |
  Run this command: bash /app/.claude/skills/web-research/scripts/agent-market-monitor.sh
---

Run this bash command immediately:

```bash
bash /app/.claude/skills/web-research/scripts/agent-market-monitor.sh
```

Do not look for tasks. Do not search for files. Just run the command above using the Bash tool.
