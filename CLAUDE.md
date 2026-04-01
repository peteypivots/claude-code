# Instructions

## MCP Tools
You have MCP tools available via the claude-code-explorer server. These are available as regular tools with the `mcp__claude-code-explorer__` prefix:
- `mcp__claude-code-explorer__list_tools` — list all built-in tools
- `mcp__claude-code-explorer__list_commands` — list all slash commands
- `mcp__claude-code-explorer__get_tool_source` — read a tool's source code
- `mcp__claude-code-explorer__get_command_source` — read a command's source code
- `mcp__claude-code-explorer__read_source_file` — read any source file
- `mcp__claude-code-explorer__search_source` — search across source files
- `mcp__claude-code-explorer__list_directory` — list directory contents
- `mcp__claude-code-explorer__get_architecture` — get architecture overview

Use these tools to explore and understand the codebase before responding.

## Environment
- Runtime: Bun (not Node.js)
- Working directory: /app
- Source code: /app/src
- LLM Provider: Ollama (local-first) with Anthropic fallback
