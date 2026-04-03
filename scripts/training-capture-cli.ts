#!/usr/bin/env bun
/**
 * training-capture-cli.ts — CLI wrapper for trainingCapture.ts
 *
 * Allows bash scripts to call centralized training capture without
 * reimplementing capture logic in shell. Reads JSON from stdin.
 *
 * Usage:
 *   echo '<json>' | bun scripts/training-capture-cli.ts multi-turn
 *   echo '<json>' | bun scripts/training-capture-cli.ts dpo
 *   echo '<json>' | bun scripts/training-capture-cli.ts fallback
 *   echo '<json>' | bun scripts/training-capture-cli.ts success
 *   echo '<json>' | bun scripts/training-capture-cli.ts tool-loop
 *   bun scripts/training-capture-cli.ts stats
 *
 * Environment:
 *   TRAINING_CAPTURE=true        — must be set to enable capture
 *   LANCEDB_URI                  — LanceDB REST API
 *   OLLAMA_BASE_URL              — Ollama for embeddings
 *   EMBEDDING_MODEL              — embedding model (default: nomic-embed-text)
 *   TRAINING_CAPTURE_VERBOSE     — enable debug logging
 */

import {
  captureMultiTurn,
  captureDPO,
  captureFallbackRecovery,
  captureSuccessfulToolUse,
  captureToolLoopRecovery,
  getCaptureStats,
} from '../src/services/llm/trainingCapture.js'

const command = process.argv[2]

if (!command) {
  console.error('Usage: training-capture-cli.ts <multi-turn|dpo|fallback|success|tool-loop|stats>')
  process.exit(1)
}

if (command === 'stats') {
  console.log(JSON.stringify(getCaptureStats()))
  process.exit(0)
}

// Read JSON from stdin
let input = ''
for await (const chunk of Bun.stdin.stream()) {
  input += new TextDecoder().decode(chunk)
}

if (!input.trim()) {
  console.error(JSON.stringify({ error: 'No JSON input on stdin' }))
  process.exit(1)
}

let data: Record<string, unknown>
try {
  data = JSON.parse(input.trim())
} catch (e) {
  console.error(JSON.stringify({ error: `Invalid JSON: ${e}` }))
  process.exit(1)
}

// Build context from common fields
const context = {
  sessionId: (data.session_id as string) || undefined,
  model: (data.model as string) || undefined,
  routingDecision: (data.routing_decision as string) || 'local',
  routingConfidence: (data.routing_confidence as number) || undefined,
  latencyMs: (data.latency_ms as number) || undefined,
}

try {
  let result: unknown

  switch (command) {
    case 'multi-turn': {
      result = await captureMultiTurn({
        userQuery: data.user_query as string,
        systemPrompt: data.system_prompt as string | undefined,
        toolCalls: (data.tool_calls as Array<{ name: string; arguments: string }>) || [],
        toolResults: (data.tool_results as Array<{ name: string; content: string; isError?: boolean }>) || [],
        finalAnswer: data.final_answer as string,
        tags: data.tags as string[] | undefined,
        context,
      })
      console.log(JSON.stringify({ stored: !!result, id: result || null }))
      break
    }

    case 'dpo': {
      result = await captureDPO({
        userQuery: data.user_query as string,
        systemPrompt: data.system_prompt as string | undefined,
        chosenResponse: data.chosen as { toolCalls?: Array<{ name: string; arguments: string }>; content?: string },
        rejectedResponse: data.rejected as { content: string },
        tags: data.tags as string[] | undefined,
        context,
      })
      console.log(JSON.stringify({ stored: !!result, id: result || null }))
      break
    }

    case 'fallback': {
      result = await captureFallbackRecovery({
        userQuery: data.user_query as string,
        systemPrompt: data.system_prompt as string | undefined,
        badResponse: data.bad_response as string,
        correctToolCall: data.correct_tool_call as { name: string; arguments: string },
        toolResult: data.tool_result as string,
        synthesizedAnswer: data.synthesized_answer as string,
        context,
      })
      console.log(JSON.stringify(result))
      break
    }

    case 'success': {
      const toolCalls = (data.tool_calls as Array<{
        name: string; arguments: string; result: string; isError?: boolean
      }>) || []
      result = await captureSuccessfulToolUse({
        userQuery: data.user_query as string,
        systemPrompt: data.system_prompt as string | undefined,
        toolCalls,
        finalAnswer: data.final_answer as string,
        context,
      })
      console.log(JSON.stringify({ stored: !!result, id: result || null }))
      break
    }

    case 'tool-loop': {
      result = await captureToolLoopRecovery({
        userQuery: data.user_query as string,
        systemPrompt: data.system_prompt as string | undefined,
        loopedToolName: data.looped_tool_name as string,
        toolCallCount: (data.tool_call_count as number) || 3,
        toolResult: data.tool_result as string,
        finalAnswer: data.final_answer as string,
        context,
      })
      console.log(JSON.stringify(result))
      break
    }

    default:
      console.error(JSON.stringify({ error: `Unknown command: ${command}` }))
      process.exit(1)
  }
} catch (e) {
  console.error(JSON.stringify({ error: `Capture failed: ${e}` }))
  process.exit(1)
}
