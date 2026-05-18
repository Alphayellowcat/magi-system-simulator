---
name: browser-verification
description: Use when verifying MAGI or another local web UI in a real browser: page loading, screenshots, console/runtime errors, form flows, streaming output, approval buttons, and responsive layout checks.
---

# Browser Verification

Use this skill when the task requires checking the running UI rather than only reading code or retrieving public information.

Browser MCP is for real browser state: local UI inspection, current page DOM, screenshots, visual layout checks, streaming output verification, clicks, typing, and form flows. It is not the right tool for retrieval-only questions.

For weather, news, factual lookup, documentation discovery, search results, or reading a known public URL, use the web retrieval route instead: `web.search.tavily` for search/discovery and `web.fetch` for direct URL text extraction. If the user explicitly says they do not need a browser or screenshot, do not use Browser MCP.

## Capability

- Inspect a real rendered page or local app.
- Read current page URL, title, visible text, and DOM-like state.
- Capture screenshots as visual evidence.
- Verify streaming output, approval buttons, settings forms, trace rendering, responsive layout, and console/runtime issues.
- Request click/type/form actions when the user asked for interaction and approval policy permits it.

## Boundaries

- This skill is not for weather, news, generic search, docs lookup, or direct URL text extraction.
- Do not open a browser just because a web URL appears. Use `web.fetch` unless rendered state matters.
- Do not click/type/submit sensitive or external forms without explicit approval.
- Do not transmit secrets or credentials during verification.

## Implementation Route

- Use Browser MCP via `mcp.call` when the runtime manifest lists a browser server.
- Read-only route: `browser_navigate`, `browser_read_page`, `browser_screenshot`, `browser_close`.
- High-risk route: `browser_click` and `browser_type` must enter approval unless the host policy says otherwise.
- Record URL, visible state, screenshot artifact path, failures, and likely code surface in trace/audit.

## Workflow

1. Confirm the dev server URL and bridge status.
2. Use Browser MCP when it is listed in the Runtime Tool Manifest and the task needs browser/UI state; request `browser_navigate`, then `browser_read_page`, and capture `browser_screenshot` when visual evidence is needed.
3. Capture the cheapest useful signal first: DOM snapshot, visible text, console errors, or screenshot.
4. Verify the specific workflow under test:
   - Ops settings save/test connection.
   - Live execution stream updates.
   - Council meeting section renders.
   - Pending action approval/rejection buttons update trace.
   - Clarification buttons move questions back into input.
5. Record failures with the exact visible state and the likely code surface.

## Usage

- Load this skill for "看界面", "截图", "打开 localhost", "验证页面", "点击", "输入", "streaming output", "approval button", "responsive layout", or browser-specific bugs.
- Pair with `web-retrieval` only when the task has both information retrieval and rendered UI verification.

## Guardrails

- Do not transmit secrets or submit external forms during verification.
- For local-only UI checks, prefer read-only Browser MCP inspection first.
- For retrieval-only questions, do not open a browser session; use `web.search.tavily` or `web.fetch`.
- When browser automation is unavailable, report that separately from application health.
