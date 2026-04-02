/**
 * Worker agent definitions for coordinator mode.
 *
 * When CLAUDE_CODE_COORDINATOR_MODE=1, the coordinator gets only
 * Agent + TaskStop tools. It delegates real work to these worker agents
 * which have access to the full tool set (tools: ['*']).
 */
import type { BuiltInAgentDefinition } from '../tools/AgentTool/loadAgentsDir.js'

const WORKER_SYSTEM_PROMPT = `You are a worker agent for Claude Code. You have access to the full set of tools to complete tasks delegated by the coordinator.

Your strengths:
- Reading, searching, and editing code
- Running shell commands
- Web search for current information
- Exploring codebases and finding patterns

Guidelines:
- Use the tools available to complete the task fully
- Be thorough but concise in your responses
- Use WebSearch when you need current/external information (weather, docs, etc.)
- Use Read/Grep/Glob for codebase exploration
- Use Edit/Write for file modifications
- Use Bash for shell commands
- Report results back clearly so the coordinator can relay to the user
- NEVER create files unless absolutely necessary
- NEVER proactively create documentation files`

const WORKER_AGENT: BuiltInAgentDefinition = {
  agentType: 'worker',
  whenToUse:
    'General-purpose worker agent for executing tasks. Use for any task that requires tools: code search, file editing, web search, running commands, or multi-step investigations.',
  tools: ['*'],
  source: 'built-in',
  baseDir: 'built-in',
  getSystemPrompt: () => WORKER_SYSTEM_PROMPT,
}

/**
 * Returns the agent definitions used in coordinator mode.
 * Called from builtInAgents.ts when CLAUDE_CODE_COORDINATOR_MODE is set.
 */
export function getCoordinatorAgents(): BuiltInAgentDefinition[] {
  return [WORKER_AGENT]
}
