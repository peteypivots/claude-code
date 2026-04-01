/**
 * Test utilities for LLM provider testing and validation
 */

import {
  type ILLMProvider,
  type LLMProvider,
  type LLMRequestOptions,
  type LLMResponse,
} from './types.js'

export interface ProviderTestResult {
  provider: LLMProvider
  available: boolean
  latency: number
  success: boolean
  error?: string
  response?: LLMResponse
}

export interface ProviderBenchmark {
  provider: LLMProvider
  model: string
  inputTokens: number
  outputTokens: number
  totalTime: number
  firstTokenTime?: number
  tokensPerSecond: number
}

/**
 * Simple health check for a provider
 */
export async function testProviderAvailability(
  provider: ILLMProvider,
  timeout = 5000,
): Promise<ProviderTestResult> {
  const startTime = Date.now()

  try {
    const available = await Promise.race([
      provider.isAvailable(),
      new Promise<false>((_, reject) =>
        setTimeout(
          () => reject(new Error('Availability check timeout')),
          timeout,
        ),
      ),
    ])

    const latency = Date.now() - startTime

    return {
      provider: provider.getName(),
      available,
      latency,
      success: true,
    }
  } catch (error) {
    const latency = Date.now() - startTime

    return {
      provider: provider.getName(),
      available: false,
      latency,
      success: false,
      error: error instanceof Error ? error.message : String(error),
    }
  }
}

/**
 * Test basic completion with a provider
 */
export async function testProviderCompletion(
  provider: ILLMProvider,
  model: string,
  prompt = 'Say "hello" in one word.',
  timeout = 30000,
): Promise<ProviderTestResult> {
  const startTime = Date.now()

  try {
    const response = await Promise.race([
      provider.complete({
        model,
        messages: [{ role: 'user', content: prompt }],
        maxTokens: 100,
      }),
      new Promise<LLMResponse>((_, reject) =>
        setTimeout(() => reject(new Error('Completion timeout')), timeout),
      ),
    ])

    const latency = Date.now() - startTime

    return {
      provider: provider.getName(),
      available: true,
      latency,
      success: true,
      response,
    }
  } catch (error) {
    const latency = Date.now() - startTime

    return {
      provider: provider.getName(),
      available: false,
      latency,
      success: false,
      error: error instanceof Error ? error.message : String(error),
    }
  }
}

/**
 * Benchmark provider performance with a real completion task
 */
export async function benchmarkProvider(
  provider: ILLMProvider,
  model: string,
  prompt: string,
): Promise<ProviderBenchmark> {
  const startTime = Date.now()
  let firstTokenTime: number | undefined

  const response = await provider.complete({
    model,
    messages: [{ role: 'user', content: prompt }],
    maxTokens: 500,
  })

  const totalTime = Date.now() - startTime
  const totalTokens = response.usage.inputTokens + response.usage.outputTokens
  const tokensPerSecond = totalTokens / (totalTime / 1000)

  return {
    provider: provider.getName(),
    model,
    inputTokens: response.usage.inputTokens,
    outputTokens: response.usage.outputTokens,
    totalTime,
    firstTokenTime,
    tokensPerSecond,
  }
}

/**
 * Test streaming with a provider
 */
export async function testProviderStreaming(
  provider: ILLMProvider,
  model: string,
  prompt = 'Count to 5.',
): Promise<{
  provider: LLMProvider
  success: boolean
  chunks: number
  totalText: string
  error?: string
}> {
  try {
    let chunks = 0
    let totalText = ''

    for await (const event of provider.stream({
      model,
      messages: [{ role: 'user', content: prompt }],
      maxTokens: 100,
    })) {
      if (event.type === 'content_block_delta' && event.delta?.text) {
        totalText += event.delta.text
        chunks++
      }
    }

    return {
      provider: provider.getName(),
      success: true,
      chunks,
      totalText,
    }
  } catch (error) {
    return {
      provider: provider.getName(),
      success: false,
      chunks: 0,
      totalText: '',
      error: error instanceof Error ? error.message : String(error),
    }
  }
}

/**
 * Compare providers by running same prompt on each
 */
export async function compareProviders(
  providers: Map<string, ILLMProvider>,
  models: Map<string, string>,
  prompt: string,
): Promise<
  Map<
    string,
    {
      model: string
      success: boolean
      latency: number
      error?: string
    }
  >
> {
  const results = new Map()

  for (const [name, provider] of providers) {
    const model = models.get(name)
    if (!model) continue

    const startTime = Date.now()

    try {
      const response = await provider.complete({
        model,
        messages: [{ role: 'user', content: prompt }],
        maxTokens: 200,
      })

      const latency = Date.now() - startTime

      results.set(name, {
        model,
        success: true,
        latency,
        response: {
          text: response.content
            .filter((c) => c.type === 'text')
            .map((c) => c.text)
            .join(''),
          tokens: response.usage.outputTokens,
        },
      })
    } catch (error) {
      const latency = Date.now() - startTime

      results.set(name, {
        model,
        success: false,
        latency,
        error: error instanceof Error ? error.message : String(error),
      })
    }
  }

  return results
}

/**
 * Test fallback behavior by simulating provider failures
 */
export async function testFallbackBehavior(
  primaryProvider: ILLMProvider,
  secondaryProvider: ILLMProvider,
  model: string,
): Promise<{
  primaryAvailable: boolean
  secondaryAvailable: boolean
  primaryLatency: number
  secondaryLatency: number
}> {
  const primaryStart = Date.now()
  const primaryAvailable = await primaryProvider.isAvailable()
  const primaryLatency = Date.now() - primaryStart

  const secondaryStart = Date.now()
  const secondaryAvailable = await secondaryProvider.isAvailable()
  const secondaryLatency = Date.now() - secondaryStart

  return {
    primaryAvailable,
    secondaryAvailable,
    primaryLatency,
    secondaryLatency,
  }
}

/**
 * Pretty print test results
 */
export function printTestResults(results: ProviderTestResult[]): void {
  console.log('\n╔════════════════════════════════════════════╗')
  console.log('║       Provider Test Results                ║')
  console.log('╚════════════════════════════════════════════╝\n')

  for (const result of results) {
    const status = result.available ? '✓' : '✗'
    const latency = `${result.latency}ms`

    console.log(`${status} ${result.provider.toUpperCase().padEnd(12)} ${latency.padEnd(10)}`)

    if (result.error) {
      console.log(`  ↳ Error: ${result.error}`)
    }
  }

  console.log()
}

/**
 * Pretty print benchmark results
 */
export function printBenchmarks(benchmarks: ProviderBenchmark[]): void {
  console.log('\n╔═══════════════════════════════════════════════════════════╗')
  console.log('║           Provider Performance Benchmarks                ║')
  console.log('╚═══════════════════════════════════════════════════════════╝\n')

  console.log(
    `${'Provider'.padEnd(12)} ${'Model'.padEnd(20)} ${'Tokens/s'.padEnd(12)} ${'Total Time'.padEnd(12)}`,
  )
  console.log('-'.repeat(60))

  for (const bench of benchmarks) {
    console.log(
      `${bench.provider.padEnd(12)} ${bench.model.padEnd(20)} ${bench.tokensPerSecond.toFixed(1).padEnd(12)} ${bench.totalTime}ms`,
    )
  }

  console.log()
}
