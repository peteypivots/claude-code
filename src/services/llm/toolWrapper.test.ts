/**
 * Phase 3 Tool Calling Tests
 * Tests the tool wrapper functionality for Ollama
 */

import {
  toolDefinitionsToPrompt,
  parseToolCalls,
  hasToolCalls,
  extractTextBeforeToolCalls,
  processToolResponse,
  prepareToolRequest,
  generateToolUseId,
  resetToolUseIdCounter,
  type ToolDefinition,
  type ExtractedToolCall,
} from './toolWrapper.js'
import type { LLMRequestOptions } from './types.js'

// ANSI colors
const colors = {
  green: '\x1b[32m',
  red: '\x1b[31m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  cyan: '\x1b[36m',
  reset: '\x1b[0m',
  dim: '\x1b[2m',
}

function log(msg: string, color: keyof typeof colors = 'reset') {
  console.log(`${colors[color]}${msg}${colors.reset}`)
}

function logSection(title: string) {
  console.log('')
  log(`${'='.repeat(60)}`, 'cyan')
  log(`  ${title}`, 'cyan')
  log(`${'='.repeat(60)}`, 'cyan')
}

interface TestResult {
  name: string
  passed: boolean
  details?: string
}

const results: TestResult[] = []

function runTest(name: string, fn: () => void): void {
  try {
    fn()
    results.push({ name, passed: true })
    log(`  ✓ ${name}`, 'green')
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error)
    results.push({ name, passed: false, details: msg })
    log(`  ✗ ${name}`, 'red')
    log(`    ${msg}`, 'dim')
  }
}

function assertEqual<T>(actual: T, expected: T, msg?: string): void {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(msg || `Expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`)
  }
}

function assertTrue(condition: boolean, msg?: string): void {
  if (!condition) {
    throw new Error(msg || 'Assertion failed')
  }
}

// ============================================================================
// Test Suite
// ============================================================================

logSection('Phase 3: Tool Wrapper Unit Tests')

// Test 1: Tool ID Generation
runTest('Generate unique tool use IDs', () => {
  resetToolUseIdCounter()
  const id1 = generateToolUseId()
  const id2 = generateToolUseId()
  
  assertTrue(id1.startsWith('toolu_'), 'ID should start with toolu_')
  assertTrue(id2.startsWith('toolu_'), 'ID should start with toolu_')
  assertTrue(id1 !== id2, 'IDs should be unique')
})

// Test 2: Tool Definitions to Prompt
runTest('Convert tool definitions to prompt format', () => {
  const tools: ToolDefinition[] = [{
    name: 'read_file',
    description: 'Read contents of a file',
    input_schema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'File path to read' },
        encoding: { type: 'string', description: 'File encoding' },
      },
      required: ['path'],
    },
  }]
  
  const prompt = toolDefinitionsToPrompt(tools)
  
  assertTrue(prompt.includes('<available_tools>'), 'Should have available_tools tag')
  assertTrue(prompt.includes('<tool name="read_file">'), 'Should have tool tag')
  assertTrue(prompt.includes('path (required)'), 'Should mark required params')
  assertTrue(prompt.includes('encoding (optional)'), 'Should mark optional params')
  assertTrue(prompt.includes('<tool_call>'), 'Should include format example')
})

// Test 3: Empty Tools
runTest('Handle empty tool list', () => {
  const prompt = toolDefinitionsToPrompt([])
  assertEqual(prompt, '', 'Empty tools should produce empty prompt')
})

// Test 4: Parse XML Tool Calls
runTest('Parse XML-formatted tool calls', () => {
  resetToolUseIdCounter()
  
  const text = `
I'll read the file for you.

<tool_call>
<name>read_file</name>
<arguments>
{
  "path": "/tmp/test.txt",
  "encoding": "utf-8"
}
</arguments>
</tool_call>
`
  
  const calls = parseToolCalls(text)
  
  assertEqual(calls.length, 1, 'Should find one tool call')
  assertEqual(calls[0].name, 'read_file', 'Should extract tool name')
  assertEqual(calls[0].input.path, '/tmp/test.txt', 'Should extract path argument')
  assertEqual(calls[0].input.encoding, 'utf-8', 'Should extract encoding argument')
  assertTrue(calls[0].id.startsWith('toolu_'), 'Should generate ID')
})

// Test 5: Parse Multiple Tool Calls
runTest('Parse multiple tool calls', () => {
  resetToolUseIdCounter()
  
  const text = `
<tool_call>
<name>list_files</name>
<arguments>{"directory": "/home"}</arguments>
</tool_call>

<tool_call>
<name>read_file</name>
<arguments>{"path": "/home/config.json"}</arguments>
</tool_call>
`
  
  const calls = parseToolCalls(text)
  
  assertEqual(calls.length, 2, 'Should find two tool calls')
  assertEqual(calls[0].name, 'list_files', 'First tool should be list_files')
  assertEqual(calls[1].name, 'read_file', 'Second tool should be read_file')
})

// Test 6: Parse Function-Call Style
runTest('Parse function-call style format', () => {
  resetToolUseIdCounter()
  
  const text = `
I'll search for that.

\`\`\`json
{
  "name": "web_search",
  "arguments": {
    "query": "typescript tutorial"
  }
}
\`\`\`
`
  
  const calls = parseToolCalls(text)
  
  assertEqual(calls.length, 1, 'Should find one tool call')
  assertEqual(calls[0].name, 'web_search', 'Should extract tool name')
  assertEqual(calls[0].input.query, 'typescript tutorial', 'Should extract query')
})

// Test 7: Has Tool Calls Detection
runTest('Detect presence of tool calls', () => {
  assertTrue(hasToolCalls('<tool_call><name>test</name></tool_call>'), 'Should detect XML format')
  assertTrue(hasToolCalls('```json\n{"name": "test"}'), 'Should detect function format')
  assertTrue(!hasToolCalls('Just regular text'), 'Should not detect in plain text')
})

// Test 8: Extract Text Before Tool Calls
runTest('Extract text before tool calls', () => {
  const text = `
Here is my analysis.

This is important context.

<tool_call>
<name>do_something</name>
<arguments>{}</arguments>
</tool_call>
`
  
  const extracted = extractTextBeforeToolCalls(text)
  
  assertTrue(extracted.includes('Here is my analysis'), 'Should include text before tool call')
  assertTrue(extracted.includes('important context'), 'Should include all pre-tool text')
  assertTrue(!extracted.includes('tool_call'), 'Should not include tool call')
})

// Test 9: Process Tool Response
runTest('Process complete tool response', () => {
  resetToolUseIdCounter()
  
  const responseText = `
I'll help you with that.

<tool_call>
<name>bash</name>
<arguments>{"command": "ls -la"}</arguments>
</tool_call>
`
  
  const { text, toolCalls } = processToolResponse(responseText)
  
  assertTrue(text.includes("I'll help you with that"), 'Should extract text')
  assertEqual(toolCalls.length, 1, 'Should extract tool call')
  assertEqual(toolCalls[0].name, 'bash', 'Should have correct tool name')
})

// Test 10: Prepare Tool Request
runTest('Prepare request with tool definitions', () => {
  const options: LLMRequestOptions = {
    model: 'qwen2.5:7b',
    messages: [{ role: 'user', content: 'Help me read a file' }],
    systemPrompt: 'You are a helpful assistant.',
  }
  
  const tools: ToolDefinition[] = [{
    name: 'read_file',
    description: 'Read a file',
    input_schema: { type: 'object', properties: {}, required: [] },
  }]
  
  const prepared = prepareToolRequest(options, tools)
  
  assertTrue(
    prepared.systemPrompt?.includes('<available_tools>'),
    'Should inject tool definitions into system prompt'
  )
  assertTrue(
    prepared.systemPrompt?.includes('You are a helpful assistant'),
    'Should preserve original system prompt'
  )
})

// Test 11: Handle Malformed JSON
runTest('Handle malformed JSON arguments gracefully', () => {
  resetToolUseIdCounter()
  
  const text = `
<tool_call>
<name>test_tool</name>
<arguments>
{
  "key": "value",
  partial
}
</arguments>
</tool_call>
`
  
  // Should not throw
  const calls = parseToolCalls(text)
  
  // May or may not extract depending on fallback success
  // The important thing is no crash
  assertTrue(true, 'Should not crash on malformed JSON')
})

// Test 12: Tool Result Conversion
runTest('Convert tool results to text format', () => {
  const options: LLMRequestOptions = {
    model: 'qwen2.5:7b',
    messages: [{
      role: 'user',
      content: [{
        type: 'tool_result',
        id: 'toolu_123',
        content: 'File contents here',
      }],
    }],
  }
  
  const prepared = prepareToolRequest(options)
  
  const msg = prepared.messages[0]
  assertTrue(typeof msg.content === 'string', 'Should convert to string')
  assertTrue(
    (msg.content as string).includes('tool_result'),
    'Should include tool_result tag'
  )
  assertTrue(
    (msg.content as string).includes('toolu_123'),
    'Should include tool use ID'
  )
})

// ============================================================================
// Summary
// ============================================================================

logSection('Test Summary')

const passed = results.filter(r => r.passed).length
const failed = results.filter(r => !r.passed).length

log(`  Passed: ${passed}`, 'green')
log(`  Failed: ${failed}`, failed > 0 ? 'red' : 'green')

if (failed > 0) {
  log('\nFailed tests:', 'red')
  for (const r of results.filter(r => !r.passed)) {
    log(`  - ${r.name}: ${r.details}`, 'red')
  }
}

console.log('')
process.exit(failed > 0 ? 1 : 0)
