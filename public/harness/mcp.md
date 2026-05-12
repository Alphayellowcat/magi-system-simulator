# MCP Registry

Model Context Protocol integration is treated as an adapter layer around the council harness.

## Concepts

- Servers expose tools, prompts, and resources.
- The MAGI browser app plans MCP calls, while direct execution happens through the local Node harness bridge.
- Tool schemas, permission gates, and audit traces must be visible to the council before execution.

## Local Bridge Config

Create `.magi/mcp/servers.json` from `.magi/mcp/servers.example.json` to enable servers locally. This file is intentionally ignored by Git because it may contain machine-specific commands, paths, and credentials.

The bridge currently supports:

- `stdio`: starts a local MCP server command and communicates over newline-delimited JSON-RPC.
- `streamableHttp`: sends JSON-RPC requests to a configured MCP HTTP endpoint and accepts JSON or SSE responses.

## Common Servers

```mcp
filesystem: configurable; local file read/write tools
browser: configurable; browser_navigate, browser_read_page, browser_screenshot, browser_click, browser_type, browser_close
github: configurable
openai-docs: configurable
```

## Execution Gate

Before executing an MCP call, the harness should know:

- server id
- tool id
- input schema
- requested arguments
- persona requesting the call
- permission state
- whether user approval is required

Read-only MCP tools may be executed during deliberation. Mutating or unclassified MCP tools must be returned as pending actions and wait for explicit user approval in the UI.
