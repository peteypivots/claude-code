#!/usr/bin/env node
/**
 * LLM Provider Test CLI Tool
 * Usage: node test-providers.mjs [options]
 */

import {
  OllamaProvider,
  AnthropicProvider,
  getGlobalLLMRouter,
} from './src/services/llm/index.js'
import {
  testProviderAvailability,
  testProviderCompletion,
  testProviderStreaming,
  testFallbackBehavior,
  printTestResults,
  compareProviders,
} from './src/services/llm/testUtils.js'

interface TestOptions {
  verbose?: boolean
  benchmark?: boolean
  stream?: boolean
  model?: string
}

async function runTests(options: TestOptions = {}): Promise<void> {
  const verbose = options.verbose ?? true
  const benchmark = options.benchmark ?? false
  const stream = options.stream ?? false
  const model = options.model ?? 'qwen2.5:7b'

  console.log('🧪 LLM Provider Test Suite\n')

  // ─── Phase 1: Health Check ───────────────────────────────
  console.log('📊 Phase 1: Provider Availability Check')
  console.log('─'.repeat(50))

  const ollama = new OllamaProvider()
  const anthropic = new AnthropicProvider()

  const [ollamaResult, anthropicResult] = await Promise.all([
    testProviderAvailability(ollama, 5000),
    testProviderAvailability(anthropic, 5000),
  ])

  printTestResults([ollamaResult, anthropicResult])

  // ─── Phase 2: Basic Completion Test ─────────────────────
  console.log('\n📝 Phase 2: Basic Completion Test')
  console.log('─'.repeat(50))

  const testPrompt = 'Say "hello" in one word.'

  if (ollamaResult.available) {
    const ollamaCompletion = await testProviderCompletion(
      ollama,
      model,
      testPrompt,
    )
    console.log(`✓ Ollama: ${ollamaCompletion.latency}ms`)
    if (verbose && ollamaCompletion.response) {
      const text = ollamaCompletion.response.content
        .filter((c) => c.type === 'text')
        .map((c) => c.text)
        .join('')
      console.log(`  Response: ${text.substring(0, 100)}...`)
    }
  } else {
    console.log(`✗ Ollama: unavailable`)
  }

  if (anthropicResult.available) {
    const anthropicCompletion = await testProviderCompletion(
      anthropic,
      'claude-3-5-sonnet-20241022',
      testPrompt,
    )
    console.log(`✓ Anthropic: ${anthropicCompletion.latency}ms`)
    if (verbose && anthropicCompletion.response) {
      const text = anthropicCompletion.response.content
        .filter((c) => c.type === 'text')
        .map((c) => c.text)
        .join('')
      console.log(`  Response: ${text.substring(0, 100)}...`)
    }
  } else {
    console.log(`✗ Anthropic: unavailable`)
  }

  // ─── Phase 3: Streaming Test ────────────────────────────
  if (stream) {
    console.log('\n\n⚡ Phase 3: Streaming Test')
    console.log('─'.repeat(50))

    if (ollamaResult.available) {
      const ollamaStream = await testProviderStreaming(ollama, model)
      console.log(`✓ Ollama streaming: ${ollamaStream.chunks} chunks`)
      if (verbose) {
        console.log(`  Text: ${ollamaStream.totalText.substring(0, 100)}...`)
      }
    }

    if (anthropicResult.available) {
      const anthropicStream = await testProviderStreaming(
        anthropic,
        'claude-3-5-sonnet-20241022',
      )
      console.log(`✓ Anthropic streaming: ${anthropicStream.chunks} chunks`)
      if (verbose) {
        console.log(`  Text: ${anthropicStream.totalText.substring( 0, 100)}...`)
      }
    }
  }

  // ─── Phase 4: Fallback Behavior ─────────────────────────
  console.log('\n\n🔄 Phase 4: Fallback Behavior')
  console.log('─'.repeat(50))

  const fallback = await testFallbackBehavior(ollama, anthropic, model)
  console.log(`Primary (Ollama):     ${fallback.primaryAvailable ? '✓' : '✗'} (${fallback.primaryLatency}ms)`)
  console.log(`Secondary (Anthropic): ${fallback.secondaryAvailable ? '✓' : '✗'} (${fallback.secondaryLatency}ms)`)

  if (fallback.primaryAvailable && fallback.secondaryAvailable) {
    const latencyDiff = Math.abs(
      fallback.primaryLatency - fallback.secondaryLatency,
    )
    const faster =
      fallback.primaryLatency < fallback.secondaryLatency ? 'Ollama' : 'Anthropic'
    console.log(`\n📈 Ollama is ${latencyDiff}ms ${fallback.primaryLatency < fallback.secondaryLatency ? 'faster' : 'slower'} than Anthropic`)
  }

  // ─── Phase 5: Global Router Test ────────────────────────
  console.log('\n\n🛣️  Phase 5: Global Router Test')
  console.log('─'.repeat(50))

  const router = getGlobalLLMRouter()
  const status = await router.getProviderStatus()

  console.log('Provider Status:')
  for (const [provider, info] of Object.entries(status)) {
    const symbol = info.available ? '✓' : '✗'
    console.log(`  ${symbol} ${provider}: ${info.available ? 'available' : 'unavailable'}`)
    if (info.error) {
      console.log(`    Error: ${info.error}`)
    }
  }

  console.log(`\nCurrent Provider: ${router.getCurrentProvider()}`)
  console.log(`Using Fallback: ${router.isUsingFallback()}`)

  // ─── Summary ────────────────────────────────────────────
  console.log('\n\n✅ Test Suite Complete!')
  console.log(''.padEnd(50, '─'))

  const summary = {
    'Ollama Available': ollamaResult.available,
    'Anthropic Available': anthropicResult.available,
    'Fallback Ready': fallback.primaryAvailable && fallback.secondaryAvailable,
  }

  for (const [key, value] of Object.entries(summary)) {
    console.log(`${key.padEnd(25)} ${value ? '✓' : '✗'}`)
  }

  console.log()
}

// Parse CLI arguments
const args = process.argv.slice(2)
const options: TestOptions = {
  verbose: !args.includes('--quiet'),
  benchmark: args.includes('--benchmark'),
  stream: args.includes('--stream'),
  model: args.includes('--model')
    ? args[args.indexOf('--model') + 1]
    : 'qwen2.5:7b',
}

// Run tests
runTests(options).catch((error) => {
  console.error('❌ Test failed:', error)
  process.exit(1)
})
