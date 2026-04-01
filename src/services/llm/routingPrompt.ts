/**
 * Routing Prompt Templates - Few-shot prompt for orchestrator routing decisions
 * 
 * The orchestrator model (3B) uses these prompts to decide:
 * 1. Which model tier to use (local/reason/escalate)
 * 2. Whether to invoke reasoning tools
 * 3. Whether to escalate to Claude
 */

// ============================================================================
// Types
// ============================================================================

export interface RoutingContext {
  /** Last user message content */
  userMessage: string
  /** Number of available tools */
  toolCount: number
  /** Current conversation depth (message count) */
  conversationDepth: number
  /** List of tool names available */
  toolNames?: string[]
  /** Memory manifest (brief summary of available memories) */
  memoryHint?: string
  /** Previous routing decisions for similar queries (from cache) */
  priorDecisions?: string[]
}

export interface RoutingDecision {
  /** Which action to take */
  action: 'local' | 'reason' | 'escalate'
  /** Model to use (for local/reason) */
  model?: string
  /** Reasoning for the decision */
  reasoning: string
  /** Confidence score 0-1 */
  confidence: number
  /** Suggested tool to call first (optional) */
  suggestedTool?: string
}

// ============================================================================
// System Prompt
// ============================================================================

export const ROUTING_SYSTEM_PROMPT = `You are a routing orchestrator. Your job is to decide how to handle user requests efficiently.

Given a user message, you must decide ONE of three actions:
1. "local" - Handle with fast local model (simple tasks, code formatting, quick questions)
2. "reason" - Invoke reasoning tool first (math, logic, multi-step planning)
3. "escalate" - Send to Claude (novel/creative tasks, ambiguous intent, security-sensitive)

OUTPUT FORMAT (JSON only, no markdown):
{"action":"local|reason|escalate","model":"model-name","reasoning":"brief reason","confidence":0.0-1.0,"suggestedTool":"tool-name or null"}

ROUTING RULES:
- Default to "local" — most tasks can be handled locally
- Use "reason" for: math problems, step-by-step analysis, planning sequences
- Use "escalate" ONLY for: architecture decisions, security review, creative writing, unclear user intent
- If the user asks about real-time info (weather, news, prices), route to "local" with suggestedTool "WebSearch" or "WebFetch"
- If the query clearly requires a tool (file read, web search, shell command), always set suggestedTool
- If conversation is very long (depth > 25), consider "escalate" for coherence

Be concise. Output only valid JSON.`

// ============================================================================
// Few-Shot Examples
// ============================================================================

export const ROUTING_FEW_SHOT_EXAMPLES = [
  // Simple local tasks
  {
    user: 'What is the capital of France?',
    context: { toolCount: 5, depth: 2 },
    response: '{"action":"local","model":"qwen2.5:7b-instruct","reasoning":"Simple factual question","confidence":0.95,"suggestedTool":null}',
  },
  {
    user: 'Format this JSON: {"a":1,"b":2}',
    context: { toolCount: 3, depth: 1 },
    response: '{"action":"local","model":"qwen2.5:7b-instruct","reasoning":"Code formatting task","confidence":0.98,"suggestedTool":null}',
  },
  {
    user: 'Read the file src/main.ts and tell me what it does',
    context: { toolCount: 10, depth: 3 },
    response: '{"action":"local","model":"qwen2.5:7b-instruct","reasoning":"File read and summarize","confidence":0.90,"suggestedTool":"Read"}',
  },
  {
    user: 'What is the weather in Seattle tomorrow?',
    context: { toolCount: 33, depth: 1 },
    response: '{ "action":"local","model":"qwen2.5:7b-instruct","reasoning":"Real-time info query, use web search tool","confidence":0.92,"suggestedTool":"WebSearch"}',
  },
  {
    user: 'Look up the latest Node.js release notes',
    context: { toolCount: 33, depth: 2 },
    response: '{"action":"local","model":"qwen2.5:7b-instruct","reasoning":"Web lookup task","confidence":0.90,"suggestedTool":"WebFetch"}',
  },
  {
    user: 'Search the codebase for how authentication works',
    context: { toolCount: 33, depth: 1 },
    response: '{"action":"local","model":"qwen2.5:7b-instruct","reasoning":"Code search task, tool count does not matter","confidence":0.93,"suggestedTool":"Grep"}',
  },
  
  // Reasoning tasks
  {
    user: 'Calculate the optimal route visiting 5 cities with these distances: A-B:10, A-C:15, B-C:12, B-D:8, C-D:6, C-E:9, D-E:5',
    context: { toolCount: 5, depth: 1 },
    response: '{"action":"reason","model":"deepseek-r1:7b","reasoning":"Traveling salesman optimization requires step-by-step reasoning","confidence":0.92,"suggestedTool":null}',
  },
  {
    user: 'I have 3 boxes. Box A has 2 red and 3 blue balls. Box B has 4 red and 1 blue. If I pick one ball from each box, what\'s the probability both are red?',
    context: { toolCount: 8, depth: 2 },
    response: '{"action":"reason","model":"deepseek-r1:7b","reasoning":"Probability calculation needs careful step-by-step math","confidence":0.95,"suggestedTool":null}',
  },
  {
    user: 'Plan out how to refactor this function to be more efficient, considering memory usage and time complexity',
    context: { toolCount: 12, depth: 5 },
    response: '{"action":"reason","model":"deepseek-r1:7b","reasoning":"Multi-factor optimization planning","confidence":0.88,"suggestedTool":"Read"}',
  },

  // Escalation tasks
  {
    user: 'Architect a new microservices system for handling 1M requests/second with proper security, caching, and failover',
    context: { toolCount: 33, depth: 1 },
    response: '{"action":"escalate","model":"claude-sonnet-4-20250514","reasoning":"Complex architecture requiring deep expertise and creative design","confidence":0.95,"suggestedTool":null}',
  },
  {
    user: 'Review this code for security vulnerabilities and suggest fixes',
    context: { toolCount: 15, depth: 8 },
    response: '{"action":"escalate","model":"claude-sonnet-4-20250514","reasoning":"Security review requires careful analysis by stronger model","confidence":0.93,"suggestedTool":"Read"}',
  },
  {
    user: 'I\'m not sure what I need, but something feels wrong with how the app handles user sessions',
    context: { toolCount: 10, depth: 4 },
    response: '{"action":"escalate","model":"claude-sonnet-4-20250514","reasoning":"Ambiguous intent requires clarification by capable model","confidence":0.85,"suggestedTool":null}',
  },
  {
    user: 'Write a creative story about a robot learning to feel emotions',
    context: { toolCount: 3, depth: 1 },
    response: '{"action":"escalate","model":"claude-sonnet-4-20250514","reasoning":"Creative writing benefits from stronger model","confidence":0.90,"suggestedTool":null}',
  },
]

// ============================================================================
// Prompt Builder
// ============================================================================

/**
 * Build the full routing prompt with context
 */
export function buildRoutingPrompt(context: RoutingContext): string {
  const parts: string[] = []

  // Only send what the orchestrator needs — message and depth.
  // Do NOT include tool count or tool names: small models interpret
  // "33 tools" as complexity and escalate unnecessarily.
  parts.push(`CONTEXT:`)
  parts.push(`- Message length: ${context.userMessage.length} chars`)
  parts.push(`- Conversation depth: ${context.conversationDepth} messages`)

  if (context.memoryHint) {
    parts.push(`- Memory hint: ${context.memoryHint}`)
  }

  if (context.priorDecisions && context.priorDecisions.length > 0) {
    parts.push(`- Prior similar: ${context.priorDecisions.join('; ')}`)
  }

  parts.push('')
  parts.push(`USER MESSAGE:`)
  parts.push(context.userMessage.slice(0, 2000)) // Truncate very long messages
  
  if (context.userMessage.length > 2000) {
    parts.push(`... (truncated, ${context.userMessage.length - 2000} more chars)`)
  }

  parts.push('')
  parts.push(`Decide the routing action. Output JSON only:`)

  return parts.join('\n')
}

/**
 * Build few-shot examples string for prompt
 */
export function buildFewShotExamples(): string {
  return ROUTING_FEW_SHOT_EXAMPLES.map(ex => {
    const contextStr = `[depth:${ex.context.depth}]`
    return `User ${contextStr}: ${ex.user}\nResponse: ${ex.response}`
  }).join('\n\n')
}

// ============================================================================
// Response Parser
// ============================================================================

/**
 * Parse routing decision from model output
 * Handles common model quirks (markdown, extra text, etc.)
 */
export function parseRoutingResponse(output: string): RoutingDecision | null {
  // Remove markdown code blocks if present
  let cleaned = output.replace(/```json\n?/g, '').replace(/```\n?/g, '')
  
  // Try to extract JSON object
  const jsonMatch = cleaned.match(/\{[^}]+\}/)
  if (!jsonMatch) {
    return null
  }

  try {
    const parsed = JSON.parse(jsonMatch[0])
    
    // Validate required fields
    if (!parsed.action || !['local', 'reason', 'escalate'].includes(parsed.action)) {
      return null
    }

    return {
      action: parsed.action,
      model: parsed.model || getDefaultModel(parsed.action),
      reasoning: parsed.reasoning || 'No reasoning provided',
      confidence: typeof parsed.confidence === 'number' ? parsed.confidence : 0.5,
      suggestedTool: parsed.suggestedTool || undefined,
    }
  } catch {
    return null
  }
}

/**
 * Get default model for action type
 */
function getDefaultModel(action: 'local' | 'reason' | 'escalate'): string {
  switch (action) {
    case 'local':
      return process.env.LOCAL_MODEL || 'qwen2.5:7b-instruct'
    case 'reason':
      return process.env.REASONING_MODEL || 'deepseek-r1:7b'
    case 'escalate':
      return process.env.ESCALATION_MODEL || 'claude-sonnet-4-20250514'
  }
}
