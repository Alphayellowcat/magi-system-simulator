# Tool Registry

This document declares the tool surface and per-persona permissions. Browser-safe tools run directly in the app; local tools run through the Node harness bridge exposed by the Vite dev server.

## Tools

### web.search.tavily

- kind: external_http
- status: implemented
- description: Search the web through Tavily and return short grounding snippets.
- inputSchema: `{ "query": "string" }`
- output: grounding sources and snippets

### mcp.call

- kind: mcp
- status: implemented-local-bridge
- description: Dispatch a tool call to a configured MCP server through the local harness bridge.
- inputSchema: `{ "server": "string", "tool": "string", "arguments": "object" }`
- config: `.magi/mcp/servers.json`

### skill.run

- kind: skill
- status: implemented-local-bridge
- description: Load a local skill package that contains a `SKILL.md` instruction file and optional assets/scripts. Script execution is disabled unless explicitly enabled in `.magi/config/bridge.json`.
- inputSchema: `{ "skill": "string", "task": "string", "mode": "load | script", "script": "optional script path", "args": "optional array" }`
- config: `.magi/config/bridge.json`

## Approval Gate

- Read-only actions such as `web.search.tavily`, `skill.run` with `mode=load`, MCP tools named like `read_*`, `list_*`, `get_*`, `search_*`, `find_*`, `stat_*`, or `inspect_*`, and Browser MCP tools `browser_navigate`, `browser_read_page`, `browser_screenshot`, `browser_close` may run automatically when permissioned.
- Browser MCP tools `browser_click` and `browser_type` must be queued for user approval.
- Mutating or ambiguous local actions must be queued as `pendingActions` and require user approval before execution.
- Approval decisions and execution results must be added to the session trace.

## Permissions

```permissions
MELCHIOR-1:web.search.tavily=allow
MELCHIOR-1:mcp.call=allow
MELCHIOR-1:skill.run=allow
BALTHASAR-2:web.search.tavily=allow
BALTHASAR-2:mcp.call=allow
BALTHASAR-2:skill.run=allow
CASPER-3:web.search.tavily=allow
CASPER-3:mcp.call=allow
CASPER-3:skill.run=allow
```

`allow` means the current harness may execute it. Local bridge execution still depends on local config files and the bridge's own filesystem/process boundaries.
