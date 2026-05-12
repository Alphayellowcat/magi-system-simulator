---
name: mcp-tool-authoring
description: Use when designing, configuring, or debugging MCP servers and tools for MAGI, including filesystem access, tool schemas, JSON-RPC transport, permissions, approval gates, and bridge integration.
---

# MCP Tool Authoring

Use this skill when the user asks MAGI to add, fix, or reason about MCP tool providers.

## Workflow

1. Identify whether the tool belongs in MCP or skill:
   - MCP exposes executable capabilities and external/local resources.
   - Skill describes workflows, procedures, and domain rules.
2. Define the server id, transport, command/url, allowed directories or credentials, and timeout.
3. List tools with `tools/list` before calling them.
4. Classify tool risk:
   - read/list/get/search/stat/inspect: low-risk read.
   - write/edit/delete/move/create/execute: requires approval.
5. Route execution through the local bridge rather than asking the model to simulate results.
6. Include tool arguments and results in trace.

## Filesystem MCP Pattern

Use configured server `filesystem` when present.

Common read calls:

- `list_allowed_directories` with `{}`
- `directory_tree` with `{ "path": ".", "excludePatterns": ["node_modules", "dist", ".git", ".magi/state"] }`
- `read_text_file` with `{ "path": "App.tsx", "head": 200 }`
- `search_files` with `{ "path": ".", "pattern": "**/*.ts" }`

Mutating filesystem tools must be queued for approval.
