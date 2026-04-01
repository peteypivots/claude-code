/**
 * ReasonTool Prompts
 * 
 * Defines the tool name, description, and prompts for the reasoning tool.
 */

export const REASON_TOOL_NAME = 'Reason' as const

export const REASON_TOOL_DESCRIPTION = `Invoke the local reasoning model (DeepSeek-R1) for deep analysis, step-by-step problem solving, or complex decision making. Use this when you need extended chain-of-thought reasoning that benefits from a specialized reasoning model.

Best used for:
- Mathematical proofs or calculations requiring step-by-step verification
- Complex algorithm design or debugging
- Multi-step logical deductions
- Trade-off analysis with many factors
- Debugging complex issues by systematic hypothesis testing

The reasoning model will return structured output with:
- <reasoning>: The detailed chain-of-thought process
- <answer>: The final conclusion or solution
- <confidence>: A confidence score (0-1) for the answer

Note: This tool calls a local 7B reasoning model. For simpler tasks, Claude's built-in reasoning is sufficient.`

export const REASON_TOOL_PROMPT = `Use the Reason tool to invoke the local reasoning model (DeepSeek-R1) for extended chain-of-thought analysis.

You must NOT invoke this tool for simple questions. It's designed for problems requiring deep, systematic reasoning:

GOOD USE CASES:
- "Walk through this recursive algorithm step by step and identify the bug"
- "Analyze these 5 architectural approaches and recommend the best one with trade-offs"
- "Prove that this function terminates for all inputs"
- "Debug why this distributed system is experiencing race conditions"

BAD USE CASES (just answer directly):
- "What does this function do?" (simple analysis)
- "Which library should I use?" (simple recommendation)
- "Fix this syntax error" (obvious fix)

The tool returns structured reasoning with a confidence score. Use the confidence to gauge reliability.`
