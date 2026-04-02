import * as React from 'react'
import type { LocalJSXCommandContext } from '../../commands.js'
import type { ToolUseContext } from '../../Tool.js'
import type { LocalJSXCommandOnDone } from '../../types/command.js'
import { getSessionId } from '../../bootstrap/state.js'
import type { UUID } from 'crypto'

/**
 * /rate <up|down> — Rate the last assistant response for training data quality.
 *
 * Writes a feedback entry to the session JSONL that the ETL pipeline
 * can pick up when building training datasets.
 */
export async function call(
  onDone: LocalJSXCommandOnDone,
  context: ToolUseContext & LocalJSXCommandContext,
  args: string,
): Promise<null> {
  const rating = args?.trim().toLowerCase()

  if (rating !== 'up' && rating !== 'down') {
    onDone('Invalid rating. Use: /rate up or /rate down', { display: 'system' })
    return null
  }

  const { sessionStorage, messages } = context

  // Find the last assistant message
  const lastAssistant = [...messages].reverse().find(m => m.type === 'assistant')
  if (!lastAssistant) {
    onDone('No assistant message found to rate.', { display: 'system' })
    return null
  }

  // Write a feedback entry to the session log
  const sessionId = getSessionId() as UUID
  const feedbackEntry = {
    type: 'training-feedback' as const,
    sessionId,
    targetUuid: lastAssistant.uuid,
    feedback: rating as 'up' | 'down',
    timestamp: new Date().toISOString(),
  }

  try {
    await sessionStorage.appendEntry(feedbackEntry as any, sessionId)
  } catch {
    console.log(`[Training] Feedback: ${rating} for message ${lastAssistant.uuid}`)
  }

  const emoji = rating === 'up' ? '👍' : '👎'
  onDone(`${emoji} Rated last response as ${rating} (will be used in training data export)`, { display: 'system' })
  return null
}
