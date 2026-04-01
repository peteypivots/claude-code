/**
 * ReasonTool - Invoke Local Reasoning Model
 * 
 * Allows Claude to delegate complex reasoning tasks to a specialized
 * reasoning model (DeepSeek-R1) for extended chain-of-thought analysis.
 */

import { z } from 'zod/v4'
import { buildTool, type ToolDef, type ValidationResult } from '../../Tool.js'
import { lazySchema } from '../../utils/lazySchema.js'
import {
  reason,
  isReasoningAvailable,
  type ReasoningRequest,
} from '../../services/llm/reasoningProvider.js'
import { REASON_TOOL_NAME, REASON_TOOL_DESCRIPTION } from './prompt.js'
import {
  renderToolUseMessage,
  renderToolResultMessage,
  renderToolUseErrorMessage,
} from './UI.js'

// ============================================================================
// Input/Output Schemas
// ============================================================================

const inputSchema = lazySchema(() =>
  z.strictObject({
    problem: z
      .string()
      .describe(
        'The problem or question to reason about. Should be detailed enough for thorough analysis. Include all relevant context, constraints, and what outcome you need.',
      ),
    context: z
      .string()
      .optional()
      .describe(
        'Additional context to help with reasoning (e.g., code snippets, data, prior analysis). Keep focused - only include what\'s necessary.',
      ),
    constraints: z
      .array(z.string())
      .optional()
      .describe(
        'Specific constraints or requirements the solution must satisfy.',
      ),
    max_reasoning_tokens: z
      .number()
      .optional()
      .describe(
        'Maximum tokens for the reasoning chain (default: 2048). Increase for very complex problems.',
      ),
  }),
)
type InputSchema = ReturnType<typeof inputSchema>

const outputSchema = lazySchema(() =>
  z.object({
    reasoning: z
      .string()
      .describe('The detailed chain-of-thought reasoning process'),
    answer: z
      .string()
      .describe('The final conclusion or solution'),
    confidence: z
      .number()
      .min(0)
      .max(1)
      .describe('Confidence score for the answer (0-1)'),
    duration_ms: z
      .number()
      .describe('Time taken for reasoning in milliseconds'),
    tokens_used: z
      .number()
      .describe('Number of tokens used in the reasoning chain'),
  }),
)
type OutputSchema = ReturnType<typeof outputSchema>
type Output = z.infer<OutputSchema>

// ============================================================================
// Tool Definition
// ============================================================================

export const ReasonTool = buildTool({
  name: REASON_TOOL_NAME,
  maxResultSizeChars: 50_000, // Reasoning can be verbose
  
  async description() {
    const available = await isReasoningAvailable()
    if (!available) {
      return `${REASON_TOOL_DESCRIPTION}\n\n⚠️ Note: Reasoning model is currently unavailable. Ensure Ollama is running with deepseek-r1:7b.`
    }
    return REASON_TOOL_DESCRIPTION
  },

  get inputSchema(): InputSchema {
    return inputSchema()
  },

  get outputSchema(): OutputSchema {
    return outputSchema()
  },

  async prompt() {
    return REASON_TOOL_DESCRIPTION
  },

  // Tool is only available if the reasoning model is accessible
  isEnabled() {
    // Note: This is synchronous. For async check, use validateInput
    return true
  },

  isConcurrencySafe() {
    return true // Reasoning doesn't need exclusive access
  },

  isReadOnly() {
    return true // No side effects
  },

  toAutoClassifierInput(input) {
    return input.problem
  },

  async validateInput(input, _context): Promise<ValidationResult> {
    const { problem } = input

    // Check if reasoning model is available
    const available = await isReasoningAvailable()
    if (!available) {
      return {
        result: false,
        message:
          'Reasoning model (DeepSeek-R1) is not available. Ensure Ollama is running with deepseek-r1:7b model.',
        errorCode: 1,
      }
    }

    // Warn about short problems (not blocking)
    if (problem.length < 50) {
      // Still valid but log a warning
      console.warn('[ReasonTool] Short problem description - consider if built-in reasoning suffices')
    }

    return { result: true }
  },

  renderToolUseMessage,
  renderToolResultMessage,
  renderToolUseErrorMessage,

  mapToolResultToToolResultBlockParam(output, toolUseID) {
    return {
      tool_use_id: toolUseID,
      type: 'tool_result',
      content: `Reasoning complete (confidence: ${(output.confidence * 100).toFixed(0)}%):\n\nAnswer: ${output.answer}`,
    }
  },

  getToolUseSummary(input) {
    if (!input?.problem) return null
    const problemPreview =
      input.problem.length > 80
        ? input.problem.slice(0, 80) + '...'
        : input.problem
    return `Reasoned: ${problemPreview}`
  },

  async call(input, _context) {
    const { problem, context: additionalContext, constraints, max_reasoning_tokens } = input

    // Build the reasoning request
    const request: ReasoningRequest = {
      problem,
      context: additionalContext,
      constraints,
      maxTokens: max_reasoning_tokens,
    }

    const result = await reason(request)

    return {
      data: {
        reasoning: result.reasoning,
        answer: result.answer,
        confidence: result.confidence,
        duration_ms: result.durationMs,
        tokens_used: result.usage.outputTokens,
      },
    }
  },
} satisfies ToolDef<InputSchema, Output>)

export { REASON_TOOL_NAME }

