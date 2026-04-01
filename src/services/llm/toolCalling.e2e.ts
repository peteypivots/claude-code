/**
 * Phase 3 End-to-End Tool Calling Test
 * Tests native tool calling with Ollama provider
 */

import { OllamaProvider } from './ollamaClient.js'
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

const OLLAMA_BASE_URL = process.env.OLLAMA_BASE_URL || 'http://localhost:11434'
const TEST_MODEL = 'qwen2.5:3b-instruct'  // Use instruct model for native tools

// Define test tools in Anthropic format (will be converted to Ollama format)
const testTools = [
  {
    name: 'get_weather',
    description: 'Get the current weather for a location',
    input_schema: {
      type: 'object',
      properties: {
        location: { type: 'string', description: 'City name or address' },
        unit: { type: 'string', enum: ['celsius', 'fahrenheit'], description: 'Temperature unit' },
      },
      required: ['location'],
    },
  },
  {
    name: 'read_file',
    description: 'Read the contents of a file from the filesystem',
    input_schema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Full path to the file' },
      },
      required: ['path'],
    },
  },
  {
    name: 'run_command',
    description: 'Execute a shell command and return the output',
    input_schema: {
      type: 'object',
      properties: {
        command: { type: 'string', description: 'The command to execute' },
        cwd: { type: 'string', description: 'Working directory (optional)' },
      },
      required: ['command'],
    },
  },
]

async function main() {
  logSection('Phase 3: Native Tool Calling Test')

  log(`\n  Configuration:`, 'blue')
  log(`    Ollama URL: ${OLLAMA_BASE_URL}`, 'dim')
  log(`    Model: ${TEST_MODEL}`, 'dim')
  log(`    Tools: ${testTools.map(t => t.name).join(', ')}`, 'dim')

  // Create native Ollama provider
  const provider = new OllamaProvider({
    baseUrl: OLLAMA_BASE_URL,
    timeout: 60000,
  })

  log('\n  Provider created successfully', 'green')

  // Test 1: Basic completion with tools (weather)
  logSection('Test 1: Tool Call Detection - Weather')

  const weatherRequest: LLMRequestOptions = {
    model: TEST_MODEL,
    messages: [
      {
        role: 'user',
        content: 'What is the weather like in Tokyo? Use the get_weather tool.',
      },
    ],
    systemPrompt: 'You are a helpful assistant. When asked about weather, use the get_weather tool.',
    tools: testTools,
    maxTokens: 1024,
  }

  log('\n  Sending request...', 'dim')
  const start1 = Date.now()

  try {
    const response = await provider.complete(weatherRequest)
    const elapsed1 = Date.now() - start1

    log(`  Response received in ${elapsed1}ms`, 'green')

    // Check stop reason
    log(`\n  Stop reason: ${response.stopReason}`, 'blue')

    // Check for tool use in content
    const toolUseBlocks = response.content.filter(c => c.type === 'tool_use')
    const textBlocks = response.content.filter(c => c.type === 'text')

    if (textBlocks.length > 0) {
      log(`\n  Text content:`, 'blue')
      for (const block of textBlocks) {
        if (block.type === 'text') {
          log(`    "${block.text.substring(0, 100)}..."`, 'dim')
        }
      }
    }

    if (toolUseBlocks.length > 0) {
      log(`\n  ✓ Tool calls detected: ${toolUseBlocks.length}`, 'green')
      for (const block of toolUseBlocks) {
        if (block.type === 'tool_use') {
          log(`    Tool: ${block.name}`, 'blue')
          log(`    ID: ${block.id}`, 'dim')
          log(`    Input: ${JSON.stringify(block.input)}`, 'dim')
        }
      }
    } else {
      log(`\n  ⚠ No tool calls in response`, 'yellow')
      log(`    Full content: ${JSON.stringify(response.content)}`, 'dim')
    }

  } catch (error) {
    log(`  ✗ Error: ${error}`, 'red')
  }

  // Test 2: File reading tool
  logSection('Test 2: Tool Call Detection - File Read')

  const fileRequest: LLMRequestOptions = {
    model: TEST_MODEL,
    messages: [
      {
        role: 'user',
        content: 'Read the file at /etc/hostname using the read_file tool.',
      },
    ],
    systemPrompt: 'You are a helpful assistant. When asked to read files, use the read_file tool.',
    tools: testTools,
    maxTokens: 1024,
  }

  log('\n  Sending request...', 'dim')
  const start2 = Date.now()

  try {
    const response = await provider.complete(fileRequest)
    const elapsed2 = Date.now() - start2

    log(`  Response received in ${elapsed2}ms`, 'green')

    const toolUseBlocks = response.content.filter(c => c.type === 'tool_use')

    if (toolUseBlocks.length > 0) {
      log(`\n  ✓ Tool calls detected: ${toolUseBlocks.length}`, 'green')
      for (const block of toolUseBlocks) {
        if (block.type === 'tool_use') {
          log(`    Tool: ${block.name}`, 'blue')
          log(`    Input: ${JSON.stringify(block.input)}`, 'dim')
        }
      }
    } else {
      log(`\n  ⚠ No tool calls in response`, 'yellow')
    }

  } catch (error) {
    log(`  ✗ Error: ${error}`, 'red')
  }

  // Test 3: Streaming with tools
  logSection('Test 3: Streaming with Tool Calls')

  const streamRequest: LLMRequestOptions = {
    model: TEST_MODEL,
    messages: [
      {
        role: 'user',
        content: 'Run the command "ls -la" using the run_command tool.',
      },
    ],
    systemPrompt: 'You are a helpful assistant. When asked to run commands, use the run_command tool.',
    tools: testTools,
    maxTokens: 1024,
  }

  log('\n  Starting stream...', 'dim')
  const start3 = Date.now()

  try {
    const stream = provider.stream(streamRequest)

    let fullText = ''
    let toolUseEvents: any[] = []
    let messageStopEvent: any = null

    for await (const event of stream) {
      if (event.type === 'content_block_delta') {
        const delta = (event as any).delta
        if (delta?.text) {
          fullText += delta.text
        }
      } else if (event.type === 'content_block_start') {
        const block = (event as any).content_block
        if (block?.type === 'tool_use') {
          toolUseEvents.push(block)
        }
      } else if (event.type === 'message_stop') {
        messageStopEvent = event
      }
    }

    const elapsed3 = Date.now() - start3
    log(`  Stream completed in ${elapsed3}ms`, 'green')

    if (fullText) {
      log(`\n  Streamed text: "${fullText.substring(0, 100)}..."`, 'dim')
    }

    if (toolUseEvents.length > 0) {
      log(`\n  ✓ Tool use events in stream: ${toolUseEvents.length}`, 'green')
      for (const block of toolUseEvents) {
        log(`    Tool: ${block.name}`, 'blue')
        log(`    Input: ${JSON.stringify(block.input)}`, 'dim')
      }
    } else if (messageStopEvent) {
      // Check if tool calls are in the final message
      const msg = (messageStopEvent as any).message
      if (msg?.content) {
        const toolBlocks = msg.content.filter((c: any) => c.type === 'tool_use')
        if (toolBlocks.length > 0) {
          log(`\n  ✓ Tool calls in final message: ${toolBlocks.length}`, 'green')
          for (const block of toolBlocks) {
            log(`    Tool: ${block.name}`, 'blue')
            log(`    Input: ${JSON.stringify(block.input)}`, 'dim')
          }
        }
      }
    }

  } catch (error) {
    log(`  ✗ Error: ${error}`, 'red')
  }

  // Test 4: No tools needed
  logSection('Test 4: Response Without Tool Use')

  const noToolRequest: LLMRequestOptions = {
    model: TEST_MODEL,
    messages: [
      {
        role: 'user',
        content: 'What is 2 + 2? Answer directly without using any tools.',
      },
    ],
    systemPrompt: 'You are a helpful assistant.',
    tools: testTools,
    maxTokens: 256,
  }

  log('\n  Sending request...', 'dim')
  const start4 = Date.now()

  try {
    const response = await provider.complete(noToolRequest)
    const elapsed4 = Date.now() - start4

    log(`  Response received in ${elapsed4}ms`, 'green')

    const toolUseBlocks = response.content.filter(c => c.type === 'tool_use')
    const textBlocks = response.content.filter(c => c.type === 'text')

    if (toolUseBlocks.length === 0 && textBlocks.length > 0) {
      log(`\n  ✓ Correctly responded without tools`, 'green')
      for (const block of textBlocks) {
        if (block.type === 'text') {
          log(`    Response: ${block.text.substring(0, 100)}`, 'dim')
        }
      }
    } else if (toolUseBlocks.length > 0) {
      log(`\n  ⚠ Unexpectedly used tools`, 'yellow')
    }

  } catch (error) {
    log(`  ✗ Error: ${error}`, 'red')
  }

  // Summary
  logSection('Test Summary')
  log('\n  End-to-end tool calling tests complete.', 'green')
  log('  Review the output above to verify tool detection behavior.', 'dim')
  console.log('')
}

main().catch(console.error)
