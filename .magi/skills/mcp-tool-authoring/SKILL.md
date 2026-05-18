---
name: mcp-tool-authoring
description: Use when designing, configuring, or debugging MCP servers and tools for MAGI, including filesystem access, tool schemas, JSON-RPC transport, permissions, approval gates, and bridge integration.
---

# MCP Tool Authoring

Use this skill when the user asks MAGI to add, fix, or reason about MCP tool providers.

## Capability

- Design, configure, inspect, and debug MCP servers used by MAGI.
- Define tool schemas, transports, server ids, timeout behavior, approval risk, and bridge integration.
- Decide whether an executable capability belongs in MCP or whether it should remain a skill workflow.

## Boundaries

- MCP exposes executable tools and external/local resources. It is not the place for long procedural instructions; those belong in a skill.
- A skill can explain how to use a tool, but it does not grant execution permission.
- Do not call MCP tools before listing or otherwise knowing the available tool surface.
- Do not auto-run mutating, destructive, credentialed, or ambiguous tools; queue them for approval.
- Do not use Browser MCP for retrieval-only web lookup. Search/fetch routes handle that.

## Implementation Route

- Use `.magi/mcp/servers.json` for local machine MCP config.
- Use the Node harness bridge for execution; the model should request `mcp.call`, not simulate tool results.
- Use `tools/list` to discover schemas and annotations before call planning.
- Include server id, tool id, arguments, actor, risk, and result in trace/audit records.

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

## Usage

- Load this skill for filesystem access, Browser MCP configuration, new MCP server creation, tool schema design, JSON-RPC/stdio/HTTP transport issues, approval classification, or bridge execution bugs.
- Pair with `harness-engineering` when the task is about how MAGI should decide or approve MCP calls.

## Filesystem MCP Pattern

Use configured server `filesystem` when present.

Common read calls:

- `list_allowed_directories` with `{}`
- `directory_tree` with `{ "path": ".", "excludePatterns": ["node_modules", "dist", ".git", ".magi/state"] }`
- `read_text_file` with `{ "path": "App.tsx", "head": 200 }`
- `search_files` with `{ "path": ".", "pattern": "**/*.ts" }`

Mutating filesystem tools must be queued for approval.
