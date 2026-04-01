/**
 * ReasonTool UI Components
 * 
 * Renders the reasoning tool output in the terminal.
 */

import * as React from 'react'
import { Box, Text } from '../../ink.js'
import { MessageResponse } from '../../components/MessageResponse.js'
import { getModeColor } from '../../utils/permissions/PermissionMode.js'
import { BLACK_CIRCLE } from '../../constants/figures.js'
import type { ProgressMessage } from '../../types/message.js'

interface ReasoningOutput {
  reasoning: string
  answer: string
  confidence: number
  duration_ms: number
  tokens_used: number
}

/**
 * Render the tool use message (when the tool is invoked)
 */
export function renderToolUseMessage(): React.ReactNode {
  return (
    <Box flexDirection="row">
      <Text color={getModeColor('default')}>{BLACK_CIRCLE} </Text>
      <Text>Invoking reasoning model...</Text>
    </Box>
  )
}

/**
 * Render the tool result message
 */
export function renderToolResultMessage(
  output: ReasoningOutput,
  _progressMessages: ProgressMessage[],
  _options?: {
    style?: 'condensed'
    isTranscriptMode?: boolean
  },
): React.ReactNode {
  const confidenceColor =
    output.confidence >= 0.8
      ? 'green'
      : output.confidence >= 0.5
        ? 'yellow'
        : 'red'

  const confidenceLabel =
    output.confidence >= 0.8
      ? 'High'
      : output.confidence >= 0.5
        ? 'Medium'
        : 'Low'

  return (
    <Box flexDirection="column">
      <Box flexDirection="row">
        <Text color={getModeColor('default')}>{BLACK_CIRCLE} </Text>
        <Text>Reasoning complete ({(output.duration_ms / 1000).toFixed(1)}s)</Text>
      </Box>
      <MessageResponse>
        <Box flexDirection="column">
          <Box marginBottom={1}>
            <Text color="cyan" bold>
              Reasoning:
            </Text>
          </Box>
          <Box marginLeft={2} marginBottom={1}>
            <Text dimColor>{formatReasoning(output.reasoning)}</Text>
          </Box>
          <Box marginBottom={1}>
            <Text color="cyan" bold>
              Answer:
            </Text>
          </Box>
          <Box marginLeft={2} marginBottom={1}>
            <Text>{output.answer}</Text>
          </Box>
          <Box flexDirection="row">
            <Text dimColor>Confidence: </Text>
            <Text color={confidenceColor}>
              {(output.confidence * 100).toFixed(0)}% ({confidenceLabel})
            </Text>
            <Text dimColor> | Tokens: {output.tokens_used}</Text>
          </Box>
        </Box>
      </MessageResponse>
    </Box>
  )
}

/**
 * Render error message
 */
export function renderToolUseErrorMessage(error: string): React.ReactNode {
  return (
    <Box flexDirection="column">
      <Box flexDirection="row">
        <Text color="red">{BLACK_CIRCLE} </Text>
        <Text color="red">Reasoning failed</Text>
      </Box>
      <MessageResponse>
        <Text color="red">{error}</Text>
      </MessageResponse>
    </Box>
  )
}

// ============================================================================
// Helpers
// ============================================================================

/**
 * Format reasoning output for display
 * Truncates very long reasoning chains and highlights key steps
 */
function formatReasoning(reasoning: string): string {
  const MAX_LINES = 20
  const lines = reasoning.split('\n')

  if (lines.length <= MAX_LINES) {
    return reasoning
  }

  // Show first 10 and last 5 lines with ellipsis
  const firstPart = lines.slice(0, 10)
  const lastPart = lines.slice(-5)
  const omitted = lines.length - 15

  return [
    ...firstPart,
    '',
    `... (${omitted} lines omitted) ...`,
    '',
    ...lastPart,
  ].join('\n')
}
