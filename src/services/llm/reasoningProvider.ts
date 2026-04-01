/**
 * Reasoning Provider - DeepSeek-R1 Integration
 * 
 * Provides chain-of-thought reasoning as a service.
 * Called by the orchestrator when tasks require step-by-step analysis.
 */

import { OllamaProvider } from './ollamaClient.js'
import type { LLMResponse } from './types.js'

// ============================================================================
// Types
// ============================================================================

export interface ReasoningRequest {
  /** The problem to reason through */
  problem: string
  /** Optional constraints to consider */
  constraints?: string[]
  /** Context from prior conversation */
  context?: string
  /** Maximum tokens for reasoning trace (default: 2048) */
  maxTokens?: number
}

export interface ReasoningResult {
  /** The final answer/conclusion */
  answer: string
  /** Full reasoning trace (chain-of-thought) */
  reasoning: string
  /** Confidence in the answer (0-1) */
  confidence: number
  /** Time taken in milliseconds */
  durationMs: number
  /** Token usage */
  usage: {
    inputTokens: number
    outputTokens: number
  }
}

export interface ReasoningConfig {
  /** Model to use (default: deepseek-r1:7b) */
  model: string
  /** Ollama base URL */
  baseUrl: string
  /** Timeout in ms (reasoning can take longer) */
  timeout: number
  /** Enable verbose logging */
  verbose: boolean
}

const DEFAULT_CONFIG: ReasoningConfig = {
  model: process.env.REASONING_MODEL || 'deepseek-r1:7b',
  baseUrl: process.env.OLLAMA_BASE_URL || 'http://localhost:11434',
  timeout: parseInt(process.env.REASONING_TIMEOUT_MS || '60000', 10), // 60 seconds
  verbose: process.env.REASONING_VERBOSE === 'true',
}

// ============================================================================
// Reasoning System Prompt
// ============================================================================

const REASONING_SYSTEM_PROMPT = `You are a careful reasoning assistant. Your job is to think through problems step by step.

APPROACH:
1. Understand what is being asked
2. Break down the problem into parts
3. Analyze each part carefully
4. Check your work
5. Provide a clear final answer

OUTPUT FORMAT:
<reasoning>
[Your step-by-step thinking process here]
</reasoning>

<answer>
[Your final answer here]
</answer>

<confidence>
[A number from 0.0 to 1.0 indicating your confidence]
</confidence>

Be thorough but efficient. Show your work.`

// ============================================================================
// Provider
// ============================================================================

let reasoningProvider: OllamaProvider | null = null

function getReasoningProvider(config: ReasoningConfig): OllamaProvider {
  if (!reasoningProvider) {
    reasoningProvider = new OllamaProvider({
      baseUrl: config.baseUrl,
      timeout: config.timeout,
      retries: 2,
    })
  }
  return reasoningProvider
}

// ============================================================================
// Main Function
// ============================================================================

/**
 * Run reasoning on a problem using DeepSeek-R1
 */
export async function reason(
  request: ReasoningRequest,
  config: Partial<ReasoningConfig> = {},
): Promise<ReasoningResult> {
  const fullConfig = { ...DEFAULT_CONFIG, ...config }
  const provider = getReasoningProvider(fullConfig)

  // Build the prompt
  const prompt = buildReasoningPrompt(request)

  if (fullConfig.verbose) {
    console.log(`[Reasoning] Starting reasoning with ${fullConfig.model}...`)
    console.log(`[Reasoning] Problem: ${request.problem.slice(0, 100)}...`)
  }

  const startTime = Date.now()

  const response = await provider.complete({
    model: fullConfig.model,
    messages: [{ role: 'user', content: prompt }],
    systemPrompt: REASONING_SYSTEM_PROMPT,
    maxTokens: request.maxTokens ?? 2048,
    temperature: 0, // Deterministic reasoning
  })

  const durationMs = Date.now() - startTime

  // Parse the response
  const result = parseReasoningResponse(response, durationMs)

  if (fullConfig.verbose) {
    console.log(`[Reasoning] Completed in ${durationMs}ms`)
    console.log(`[Reasoning] Confidence: ${result.confidence}`)
  }

  return result
}

/**
 * Stream reasoning output (for real-time display of thinking)
 */
export async function* reasonStream(
  request: ReasoningRequest,
  config: Partial<ReasoningConfig> = {},
): AsyncGenerator<{ type: 'reasoning' | 'answer' | 'done'; text: string }> {
  const fullConfig = { ...DEFAULT_CONFIG, ...config }
  const provider = getReasoningProvider(fullConfig)

  const prompt = buildReasoningPrompt(request)

  let buffer = ''
  let inReasoning = false
  let inAnswer = false

  for await (const event of provider.stream({
    model: fullConfig.model,
    messages: [{ role: 'user', content: prompt }],
    systemPrompt: REASONING_SYSTEM_PROMPT,
    maxTokens: request.maxTokens ?? 2048,
    temperature: 0,
  })) {
    if (event.type === 'content_block_delta' && event.delta?.text) {
      buffer += event.delta.text

      // Check for section transitions
      if (buffer.includes('<reasoning>') && !inReasoning) {
        inReasoning = true
        buffer = buffer.split('<reasoning>')[1] || ''
      }

      if (buffer.includes('</reasoning>') && inReasoning) {
        const [reasoningPart] = buffer.split('</reasoning>')
        yield { type: 'reasoning', text: reasoningPart }
        buffer = buffer.split('</reasoning>')[1] || ''
        inReasoning = false
      }

      if (buffer.includes('<answer>') && !inAnswer) {
        inAnswer = true
        buffer = buffer.split('<answer>')[1] || ''
      }

      if (buffer.includes('</answer>') && inAnswer) {
        const [answerPart] = buffer.split('</answer>')
        yield { type: 'answer', text: answerPart }
        buffer = buffer.split('</answer>')[1] || ''
        inAnswer = false
      }

      // Yield partial reasoning as it comes
      if (inReasoning && buffer.length > 50) {
        yield { type: 'reasoning', text: buffer }
        buffer = ''
      }
    }

    if (event.type === 'message_stop') {
      yield { type: 'done', text: '' }
    }
  }
}

// ============================================================================
// Helpers
// ============================================================================

/**
 * Build the prompt for reasoning
 */
function buildReasoningPrompt(request: ReasoningRequest): string {
  const parts: string[] = []

  if (request.context) {
    parts.push('CONTEXT:')
    parts.push(request.context)
    parts.push('')
  }

  parts.push('PROBLEM:')
  parts.push(request.problem)

  if (request.constraints && request.constraints.length > 0) {
    parts.push('')
    parts.push('CONSTRAINTS:')
    for (const constraint of request.constraints) {
      parts.push(`- ${constraint}`)
    }
  }

  parts.push('')
  parts.push('Think through this step by step and provide your answer.')

  return parts.join('\n')
}

/**
 * Parse the reasoning response
 */
function parseReasoningResponse(response: LLMResponse, durationMs: number): ReasoningResult {
  const text = response.content
    .filter(c => c.type === 'text')
    .map(c => c.text || '')
    .join('')

  // Extract reasoning
  const reasoningMatch = text.match(/<reasoning>([\s\S]*?)<\/reasoning>/i)
  const reasoning = reasoningMatch?.[1]?.trim() || text

  // Extract answer
  const answerMatch = text.match(/<answer>([\s\S]*?)<\/answer>/i)
  const answer = answerMatch?.[1]?.trim() || extractFinalAnswer(text)

  // Extract confidence
  const confidenceMatch = text.match(/<confidence>([\d.]+)<\/confidence>/i)
  const confidence = confidenceMatch ? parseFloat(confidenceMatch[1]) : 0.7

  return {
    answer,
    reasoning,
    confidence: Math.min(1, Math.max(0, confidence)),
    durationMs,
    usage: response.usage,
  }
}

/**
 * Extract final answer when XML tags aren't present
 */
function extractFinalAnswer(text: string): string {
  // Look for common answer patterns
  const patterns = [
    /(?:therefore|thus|so|hence|finally|in conclusion)[,:]?\s*(.+?)(?:\.|$)/i,
    /(?:the answer is|answer:)\s*(.+?)(?:\.|$)/i,
    /(?:result:)\s*(.+?)(?:\.|$)/i,
  ]

  for (const pattern of patterns) {
    const match = text.match(pattern)
    if (match) {
      return match[1].trim()
    }
  }

  // Fall back to last sentence
  const sentences = text.split(/[.!?]+/).filter(s => s.trim())
  return sentences[sentences.length - 1]?.trim() || text.slice(-200)
}

// ============================================================================
// Health Check
// ============================================================================

/**
 * Check if reasoning model is available
 */
export async function isReasoningAvailable(
  config: Partial<ReasoningConfig> = {},
): Promise<boolean> {
  const fullConfig = { ...DEFAULT_CONFIG, ...config }
  const provider = getReasoningProvider(fullConfig)
  
  try {
    const available = await provider.isAvailable()
    if (!available) return false

    // Check if specific model is loaded
    const response = await fetch(`${fullConfig.baseUrl}/api/tags`)
    if (!response.ok) return false
    
    const data = await response.json() as { models: Array<{ name: string }> }
    return data.models.some(m => m.name.includes('deepseek-r1') || m.name.includes('r1'))
  } catch {
    return false
  }
}

// ============================================================================
// Exports
// ============================================================================

export { DEFAULT_CONFIG as REASONING_CONFIG }
