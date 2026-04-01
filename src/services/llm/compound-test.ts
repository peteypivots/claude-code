/**
 * Quick test script for the compound AI system
 * 
 * Run with: bun run src/services/llm/compound-test.ts
 */

import { getModelPool, getBestAvailableModel } from './modelPool.js'
import { getRoutingDecision, clearRoutingCache, getCacheStats } from './orchestratorModel.js'
import { reason, isReasoningAvailable } from './reasoningProvider.js'
import { sideQuery } from './sideQueryProvider.js'

async function runTests() {
  console.log('='.repeat(60))
  console.log('Compound AI System Test')
  console.log('='.repeat(60))
  console.log()

  // Test 1: Model Pool
  console.log('1. Testing Model Pool...')
  const pool = getModelPool()
  console.log('   Pool status:')
  for (const model of pool.getStatus()) {
    console.log(`   - ${model.tier}: ${model.modelId} (${model.provider}) - ${model.healthy ? 'healthy' : 'unhealthy'}`)
  }
  console.log()

  // Test 2: Health Check
  console.log('2. Running health checks...')
  await pool.checkHealth()
  console.log(`   Healthy models: ${pool.getHealthyCount()}/4`)
  console.log(`   Local capability: ${pool.hasLocalCapability() ? 'Yes' : 'No'}`)
  console.log()

  // Test 3: Reasoning Availability
  console.log('3. Checking reasoning model...')
  const reasoningAvailable = await isReasoningAvailable()
  console.log(`   DeepSeek-R1 available: ${reasoningAvailable ? 'Yes' : 'No'}`)
  console.log()

  // Test 4: Simple routing decision
  console.log('4. Testing routing decisions...')
  
  const simpleContext = {
    userMessage: 'What is 2 + 2?',
    toolCount: 5,
    conversationDepth: 1,
    toolNames: ['Read', 'Write', 'Search', 'Bash', 'Glob'],
  }
  
  try {
    const simpleDecision = await getRoutingDecision(simpleContext)
    console.log(`   Simple query: action=${simpleDecision.action}, confidence=${simpleDecision.confidence}`)
  } catch (e) {
    console.log(`   Simple query: ERROR - ${e.message}`)
  }

  const complexContext = {
    userMessage: 'Refactor this TypeScript class to use dependency injection with proper interfaces and add comprehensive unit tests using vitest',
    toolCount: 10,
    conversationDepth: 5,
    toolNames: ['Read', 'Write', 'Search', 'Bash', 'Glob', 'Edit', 'Agent', 'Task', 'Review', 'Reason'],
  }

  try {
    const complexDecision = await getRoutingDecision(complexContext)
    console.log(`   Complex query: action=${complexDecision.action}, confidence=${complexDecision.confidence}`)
  } catch (e) {
    console.log(`   Complex query: ERROR - ${e.message}`)
  }
  console.log()

  // Test 5: Cache
  console.log('5. Checking routing cache...')
  const stats = getCacheStats()
  console.log(`   Hits: ${stats.hits}, Misses: ${stats.misses}, Entries: ${stats.entries}`)
  console.log()

  // Test 6: Side Query (if models available)
  if (pool.hasLocalCapability()) {
    console.log('6. Testing side query...')
    try {
      const result = await sideQuery({
        prompt: 'Respond with only "OK" if you can read this.',
        maxTokens: 10,
      })
      console.log(`   Side query response: "${result.text.trim()}" (${result.provider})`)
    } catch (e) {
      console.log(`   Side query: ERROR - ${e.message}`)
    }
  } else {
    console.log('6. Skipping side query (no local capability)')
  }
  console.log()

  // Test 7: Reasoning (optional, takes longer)
  if (reasoningAvailable && process.env.TEST_REASONING === 'true') {
    console.log('7. Testing reasoning (this may take a minute)...')
    try {
      const reasoningResult = await reason({
        problem: 'What is the sum of the first 5 prime numbers?',
        maxTokens: 512,
      })
      console.log(`   Answer: ${reasoningResult.answer}`)
      console.log(`   Confidence: ${reasoningResult.confidence}`)
      console.log(`   Duration: ${reasoningResult.durationMs}ms`)
    } catch (e) {
      console.log(`   Reasoning: ERROR - ${e.message}`)
    }
  } else {
    console.log('7. Skipping reasoning test (set TEST_REASONING=true to enable)')
  }
  console.log()

  // Cleanup
  clearRoutingCache()
  pool.stopHealthChecks()

  console.log('='.repeat(60))
  console.log('Test complete!')
  console.log('='.repeat(60))
}

// Run tests
runTests().catch(console.error)
