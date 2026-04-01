#!/usr/bin/env node
/**
 * Explore the Claude Code MCP server tools by calling each one and capturing outputs.
 * 
 * Usage:
 *   cd /home/ables/gitroot/claude-code-full/mcp-server
 *   CLAUDE_CODE_SRC_ROOT=/home/ables/gitroot/claude-code-full/src node explore_tools.mjs
 */

import { createServer, SRC_ROOT } from './dist/src/server.js';

async function main() {
  console.log(`Source root: ${SRC_ROOT}\n`);
  
  const server = createServer();
  
  // Get tool list
  const toolsReq = { method: 'tools/list', params: {} };
  
  // We need to call the handlers directly since we're not going through transport
  // Let's just import and call the functions directly
  
  const tools = [
    { name: 'list_tools', args: {} },
    { name: 'list_commands', args: {} },
    { name: 'get_architecture', args: {} },
    { name: 'list_directory', args: { path: '' } },
    { name: 'list_directory', args: { path: 'tools' } },
    { name: 'list_tools', args: {} },
    { name: 'get_tool_source', args: { toolName: 'BashTool' } },
    { name: 'search_source', args: { pattern: 'export class.*Tool', maxResults: 10 } },
    { name: 'read_source_file', args: { path: 'main.tsx', startLine: 1, endLine: 30 } },
  ];
  
  for (const tool of tools) {
    console.log(`\n${'='.repeat(60)}`);
    console.log(`Tool: ${tool.name}`);
    console.log(`Args: ${JSON.stringify(tool.args)}`);
    console.log('='.repeat(60));
    
    try {
      // We need to simulate calling the tool through the server
      // For now, let's just print what we would call
      console.log('(See server.ts CallToolRequestSchema handler for implementation)');
    } catch (err) {
      console.error(`Error: ${err.message}`);
    }
  }
}

main().catch(console.error);
