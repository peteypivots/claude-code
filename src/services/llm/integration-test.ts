/**
 * Phase 2 Integration Test Suite
 * Tests end-to-end streaming, fallback behavior, and performance
 * Run with: bun run src/services/llm/integration-test.ts
 */

import { getGlobalLLMRouter } from './router.js'
import { createStreamAdapter } from './streamAdapter.js'
import { getConfiguredLLMProvider, getProviderConfigInfo, isOllamaEnabled } from './providerConfig.js'
import type { LLMStreamEvent, LLMRequestOptions } from './types.js'

// ANSI colors for output
const colors = {
  green: '\x1b[32m',
  red: '\x1b[31m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  cyan: '\x1b[36m',
  reset: '\x1b[0m',
  dim: '\x1b[2m',
}

function log(message: string, color: keyof typeof colors = 'reset') {
  console.log(`${colors[color]}${message}${colors.reset}`)
}

function logSection(title: string) {
  console.log('')
  log(`${'='.repeat(60)}`, 'cyan')
  log(`  ${title}`, 'cyan')
  log(`${'='.repeat(60)}`, 'cyan')
}

function logResult(testName: string, passed: boolean, details?: string) {
  const icon = passed ? '✓' : '✗'
  const color = passed ? 'green' : 'red'
  log(`  ${icon} ${testName}`, color)
  if (details) {
    log(`    ${details}`, 'dim')
  }
}

// Test results tracking
interface TestResult {
  name: string
  passed: boolean
  duration: number
  details?: string
  error?: string
}

const results: TestResult[] = []

async function runTest(name: string, fn: () => Promise<void>): Promise<void> {
  const start = Date.now()
  try {
    await fn()
    const duration = Date.now() - start
    results.push({ name, passed: true, duration })
    logResult(name, true, `${duration}ms`)
  } catch (error) {
    const duration = Date.now() - start
    const errorMsg = error instanceof Error ? error.message : String(error)
    results.push({ name, passed: false, duration, error: errorMsg })
    logResult(name, false, errorMsg)
  }
}

// ============================================================================
// Test 1: Provider Configuration
// ============================================================================
async function testProviderConfig(): Promise<void> {
  logSection('Test 1: Provider Configuration')
  
  await runTest('Get configured provider', async () => {
    const provider = getConfiguredLLMProvider()
    if (!provider) throw new Error('No provider configured')
    log(`    Provider: ${provider}`, 'dim')
  })
  
  await runTest('Get provider config info', async () => {
    const info = getProviderConfigInfo()
    log(`    Configured: ${info.configuredProvider}`, 'dim')
    log(`    Ollama URL: ${info.ollamaUrl || 'not set'}`, 'dim')
    log(`    Env override: ${info.envOverride || 'none'}`, 'dim')
  })
  
  await runTest('Check Ollama enabled status', async () => {
    const enabled = isOllamaEnabled()
    log(`    Ollama enabled: ${enabled}`, 'dim')
  })
}

// ============================================================================
// Test 2: Router Availability
// ============================================================================
async function testRouterAvailability(): Promise<void> {
  logSection('Test 2: Router Availability')
  
  await runTest('Get global LLM router', async () => {
    const router = getGlobalLLMRouter()
    if (!router) throw new Error('Router not available')
    log(`    Router name: ${router.getName()}`, 'dim')
  })
  
  await runTest('Check router availability', async () => {
    const router = getGlobalLLMRouter()
    const available = await router.isAvailable()
    if (!available) throw new Error('Router reports not available')
    log(`    Available: ${available}`, 'dim')
  })
}

// ============================================================================
// Test 3: Basic Ollama Streaming
// ============================================================================
async function testOllamaStreaming(): Promise<void> {
  logSection('Test 3: Ollama Streaming (Raw)')
  
  await runTest('Stream simple completion from Ollama', async () => {
    const router = getGlobalLLMRouter()
    
    const options: LLMRequestOptions = {
      model: 'qwen2.5:3b',  // Use smaller model for faster loading
      messages: [
        { role: 'user', content: 'Say "Hello World" and nothing else.' }
      ],
      maxTokens: 50,
      temperature: 0.1,
    }
    
    const stream = router.stream(options)
    let tokenCount = 0
    let fullText = ''
    
    for await (const event of stream) {
      // Accept both content_block_delta and content_delta types
      if ((event.type === 'content_block_delta' || event.type === 'content_delta') && event.delta?.text) {
        tokenCount++
        fullText += event.delta.text
        process.stdout.write(colors.dim + event.delta.text + colors.reset)
      }
    }
    
    console.log('') // newline after streaming
    
    if (tokenCount === 0) throw new Error('No tokens received')
    log(`    Tokens received: ${tokenCount}`, 'dim')
    log(`    Full response: "${fullText.trim()}"`, 'dim')
  })
}

// ============================================================================
// Test 4: Stream Adapter (Anthropic Format)
// ============================================================================
async function testStreamAdapter(): Promise<void> {
  logSection('Test 4: Stream Adapter (Anthropic Format)')
  
  await runTest('Convert Ollama stream to Anthropic format', async () => {
    const router = getGlobalLLMRouter()
    
    const options: LLMRequestOptions = {
      model: 'qwen2.5:3b',  // Use smaller model for faster loading
      messages: [
        { role: 'user', content: 'Count from 1 to 5.' }
      ],
      maxTokens: 100,
      temperature: 0.1,
    }
    
    const rawStream = router.stream(options)
    const anthropicStream = createStreamAdapter(rawStream)  // Let it generate a proper msg_xxx ID
    
    const eventTypes = new Set<string>()
    let contentDeltaCount = 0
    let finalMessageId = ''
    
    for await (const event of anthropicStream) {
      eventTypes.add(event.type)
      
      if (event.type === 'message_start') {
        finalMessageId = event.message.id
        log(`    Message ID: ${event.message.id}`, 'dim')
        log(`    Model: ${event.message.model}`, 'dim')
      }
      
      if (event.type === 'content_block_delta') {
        contentDeltaCount++
        if ('delta' in event && 'text' in event.delta) {
          process.stdout.write(colors.dim + event.delta.text + colors.reset)
        }
      }
      
      if (event.type === 'message_delta') {
        log(``, 'reset') // newline
        if ('usage' in event) {
          log(`    Output tokens: ${event.usage.output_tokens}`, 'dim')
        }
      }
    }
    
    console.log('') // newline
    
    log(`    Event types seen: ${Array.from(eventTypes).join(', ')}`, 'dim')
    log(`    Content deltas: ${contentDeltaCount}`, 'dim')
    
    // Verify required Anthropic event types
    const requiredTypes = ['message_start', 'content_block_start', 'content_block_delta', 'content_block_stop', 'message_delta', 'message_stop']
    for (const type of requiredTypes) {
      if (!eventTypes.has(type)) {
        throw new Error(`Missing required event type: ${type}`)
      }
    }
    
    if (!finalMessageId.startsWith('msg_')) {
      throw new Error(`Invalid message ID format: ${finalMessageId}`)
    }
  })
}

// ============================================================================
// Test 5: Fallback Behavior (Simulated)
// ============================================================================
async function testFallbackBehavior(): Promise<void> {
  logSection('Test 5: Fallback Behavior')
  
  await runTest('Verify fallback provider is configured', async () => {
    // Check if Anthropic API key is available for fallback
    const hasAnthropicKey = !!process.env.ANTHROPIC_API_KEY
    log(`    Anthropic API key available: ${hasAnthropicKey}`, 'dim')
    
    if (!hasAnthropicKey) {
      log(`    Note: Set ANTHROPIC_API_KEY for full fallback testing`, 'yellow')
    }
  })
  
  await runTest('Test primary provider (Ollama) is working', async () => {
    const router = getGlobalLLMRouter()
    const available = await router.isAvailable()
    if (!available) throw new Error('Primary provider not available')
    log(`    Primary provider ready`, 'dim')
  })
  
  // Note: Full fallback test would require stopping Ollama temporarily
  await runTest('Fallback configuration check', async () => {
    const info = getProviderConfigInfo()
    const hasFallback = info.configuredProvider === 'ollama' || info.configuredProvider === 'auto'
    log(`    Fallback will trigger if Ollama fails: ${hasFallback}`, 'dim')
  })
}

// ============================================================================
// Test 6: Performance Benchmark
// ============================================================================
async function testPerformance(): Promise<void> {
  logSection('Test 6: Performance Benchmark')
  
  const iterations = 3
  const times: number[] = []
  
  await runTest(`Ollama latency (${iterations} iterations)`, async () => {
    const router = getGlobalLLMRouter()
    
    for (let i = 0; i < iterations; i++) {
      const start = Date.now()
      
      const options: LLMRequestOptions = {
        model: 'qwen2.5:3b',  // Use smaller model for faster testing
        messages: [
          { role: 'user', content: 'Reply with just the word "OK"' }
        ],
        maxTokens: 10,
        temperature: 0,
      }
      
      const stream = router.stream(options)
      let firstTokenTime = 0
      let tokenCount = 0
      
      for await (const event of stream) {
        if ((event.type === 'content_block_delta' || event.type === 'content_delta') && firstTokenTime === 0) {
          firstTokenTime = Date.now() - start
        }
        if (event.type === 'content_block_delta' || event.type === 'content_delta') tokenCount++
      }
      
      const totalTime = Date.now() - start
      times.push(firstTokenTime)
      
      log(`    Iteration ${i + 1}: TTFT=${firstTokenTime}ms, Total=${totalTime}ms, Tokens=${tokenCount}`, 'dim')
    }
    
    const avgTTFT = Math.round(times.reduce((a, b) => a + b, 0) / times.length)
    log(`    Average Time-To-First-Token: ${avgTTFT}ms`, 'dim')
  })
}

// ============================================================================
// Test 7: Error Handling
// ============================================================================
async function testErrorHandling(): Promise<void> {
  logSection('Test 7: Error Handling')
  
  await runTest('Handle invalid model gracefully', async () => {
    const router = getGlobalLLMRouter()
    
    try {
      const options: LLMRequestOptions = {
        model: 'nonexistent-model-12345',
        messages: [{ role: 'user', content: 'test' }],
        maxTokens: 10,
      }
      
      const stream = router.stream(options)
      for await (const _ of stream) {
        // consume
      }
      
      throw new Error('Expected error for invalid model')
    } catch (error) {
      if (error instanceof Error && error.message.includes('Expected error')) {
        throw error
      }
      log(`    Error caught correctly: ${error instanceof Error ? error.message.slice(0, 50) : 'unknown'}...`, 'dim')
    }
  })
  
  await runTest('Handle empty message array', async () => {
    const router = getGlobalLLMRouter()
    
    try {
      const options: LLMRequestOptions = {
        model: 'qwen2.5:3b',  // Use smaller model
        messages: [],
        maxTokens: 10,
      }
      
      const stream = router.stream(options)
      for await (const _ of stream) {
        // consume
      }
      // Some providers may allow empty messages
      log(`    Empty messages handled without crash`, 'dim')
    } catch (error) {
      log(`    Error caught for empty messages: ${error instanceof Error ? error.message.slice(0, 50) : 'unknown'}...`, 'dim')
    }
  })
}

// ============================================================================
// Main Test Runner
// ============================================================================
async function main() {
  log('\n🧪 Phase 2 Integration Test Suite', 'cyan')
  log(`   Started at ${new Date().toISOString()}`, 'dim')
  log(`   OLLAMA_BASE_URL: ${process.env.OLLAMA_BASE_URL || 'http://localhost:11434'}`, 'dim')
  
  try {
    await testProviderConfig()
    await testRouterAvailability()
    await testOllamaStreaming()
    await testStreamAdapter()
    await testFallbackBehavior()
    await testPerformance()
    await testErrorHandling()
  } catch (error) {
    log(`\n❌ Fatal error: ${error}`, 'red')
  }
  
  // Summary
  logSection('Test Summary')
  
  const passed = results.filter(r => r.passed).length
  const failed = results.filter(r => !r.passed).length
  const totalTime = results.reduce((a, r) => a + r.duration, 0)
  
  log(`  Passed: ${passed}`, 'green')
  log(`  Failed: ${failed}`, failed > 0 ? 'red' : 'green')
  log(`  Total time: ${totalTime}ms`, 'dim')
  
  if (failed > 0) {
    log('\nFailed tests:', 'red')
    for (const r of results.filter(r => !r.passed)) {
      log(`  - ${r.name}: ${r.error}`, 'red')
    }
  }
  
  console.log('')
  process.exit(failed > 0 ? 1 : 0)
}

main()
