# Tool Registry

This document declares the tool surface and per-persona permissions. Browser-safe tools run directly in the app; local tools run through the Node harness bridge exposed by the Vite dev server.

Planning uses model-native function `tool_calls`. The model sees provider-facing function names (`web_search_tavily`, `skill_run`, `mcp_call`); the MAGI host maps those calls to the canonical registry ids below, applies permission/risk checks, executes allowed read-only actions, and queues risky actions for approval. The model never executes functions by itself.

Runtime also applies the Tool Access Matrix from Ops / `npm run magi:matrix`. The markdown registry grants coarse canonical ids (`web.search.tavily`, `web.fetch`, `skill.run`, `mcp.call`); the matrix narrows those ids by persona and capability (`skill.run.load`, `mcp.filesystem.read`, `mcp.browser.interact`, etc.).

## Tools

### web.search.tavily

- kind: external_http
- status: implemented
- description: Search the web through Tavily and return short grounding snippets.
- inputSchema: `{ "query": "string" }`
- output: grounding sources and snippets

### web.fetch

- kind: external_http
- status: implemented-local-bridge
- description: Fetch and extract readable text from a known HTTP(S) URL without opening a browser.
- inputSchema: `{ "url": "string", "maxChars": "optional number" }`
- output: URL, status, title, content type, and extracted readable text

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

- Read-only actions such as `web.search.tavily`, `web.fetch`, `skill.run` with `mode=load`, MCP tools named like `read_*`, `list_*`, `get_*`, `search_*`, `find_*`, `stat_*`, or `inspect_*`, and Browser MCP tools `browser_navigate`, `browser_read_page`, `browser_screenshot`, `browser_close` may run automatically when permissioned.
- Use `web.search.tavily` and `web.fetch` for retrieval-only tasks: weather, news, factual lookup, documentation discovery, or reading a known URL.
- Use Browser MCP only when the task needs real browser state: local UI inspection, current page DOM, screenshots, visual layout verification, click/type interaction, streaming UI checks, or form workflows.
- If the user explicitly says no browser or no screenshot, do not request Browser MCP for that turn.
- Browser MCP tools `browser_click` and `browser_type` must be queued for user approval.
- Mutating or ambiguous local actions must be queued as `pendingActions` and require user approval before execution.
- Tool Access Matrix `allow` means low-risk calls can auto-run, `review` means the persona may request the call but it enters approval even if low-risk, and `deny` blocks that persona from requesting the capability.
- Approval decisions and execution results must be added to the session trace.

## Permissions

```permissions
MELCHIOR-1:web.search.tavily=allow
MELCHIOR-1:web.fetch=allow
MELCHIOR-1:mcp.call=allow
MELCHIOR-1:skill.run=allow
BALTHASAR-2:web.search.tavily=allow
BALTHASAR-2:web.fetch=allow
BALTHASAR-2:mcp.call=allow
BALTHASAR-2:skill.run=allow
CASPER-3:web.search.tavily=allow
CASPER-3:web.fetch=allow
CASPER-3:mcp.call=allow
CASPER-3:skill.run=allow
```

`allow` means the current harness may execute it. Local bridge execution still depends on local config files and the bridge's own filesystem/process boundaries.
