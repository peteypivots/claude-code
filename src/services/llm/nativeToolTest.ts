/**
 * Quick test for native tool calling
 */

import { OllamaProvider } from './ollamaClient.js'

const provider = new OllamaProvider({
  baseUrl: 'http://localhost:11434',
  timeout: 60000,
})

const tools = [{
  name: 'get_weather',
  description: 'Get weather for a location',
  input_schema: { 
    type: 'object', 
    properties: { location: { type: 'string' } }, 
    required: ['location'] 
  },
}]

console.log('Testing native tool calling with qwen2.5:3b-instruct...\n')

try {
  const response = await provider.complete({
    model: 'qwen2.5:3b-instruct',
    messages: [{ role: 'user', content: 'What is the weather in Tokyo?' }],
    systemPrompt: 'You are a helpful assistant.',
    tools,
    maxTokens: 512,
  })

  console.log('Stop reason:', response.stopReason)
  console.log('Content:', JSON.stringify(response.content, null, 2))
  
  // Verify tool_use block exists
  const hasToolUse = response.content.some(c => c.type === 'tool_use')
  console.log('\n✓ Tool use detected:', hasToolUse)
  
  if (hasToolUse) {
    const toolUse = response.content.find(c => c.type === 'tool_use')
    if (toolUse && toolUse.type === 'tool_use') {
      console.log('  Tool name:', toolUse.name)
      console.log('  Tool ID:', toolUse.id)
      console.log('  Tool input:', JSON.stringify(toolUse.input))
    }
  }
} catch (error) {
  console.error('Error:', error)
}
