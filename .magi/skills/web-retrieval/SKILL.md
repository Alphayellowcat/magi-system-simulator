---
name: web-retrieval
description: Use for retrieval-only web tasks: weather, news, factual lookup, documentation discovery, search result grounding, or extracting readable text from a known URL without browser UI verification.
---

# Web Retrieval

Use this skill when the user needs information from the web, not interaction with a rendered browser page.

## Capability

- Search the web for current or external information.
- Fetch readable text from a known HTTP(S) URL.
- Ground answers with retrieved snippets and source URLs.
- Handle retrieval-only tasks such as weather, news, factual lookup, documentation discovery, and public page extraction.

## Boundaries

- This skill does not inspect rendered browser state, screenshots, logged-in tabs, forms, or UI layout.
- Do not click, type, submit forms, transmit secrets, or use Browser MCP for retrieval-only work.
- If the task needs JavaScript-rendered state, current local UI, screenshots, or interaction, hand off to `browser-verification`.
- If the user explicitly says no browser or no screenshot, never escalate to Browser MCP for that turn.

## Tool Route

- Use `web.search.tavily` when the task needs discovery: weather, news, current facts, search results, source finding, or "look up" requests.
- Use `web.fetch` when the task names a specific HTTP(S) URL and needs readable page text.
- Use Browser MCP only when the task explicitly needs real browser state: local UI inspection, current DOM, screenshots, click/type interaction, streaming UI verification, or visual layout checks.
- If the user says "no browser", "no screenshot", "不需要浏览器", or "不需要截图", treat that as a hard routing signal for web retrieval tools.

## Implementation Route

- Request native `tool_calls`: `web_search_tavily` for discovery and `web_fetch` for known URL extraction.
- Keep calls small: one focused query or one direct URL fetch first.
- Use the runtime clock for relative dates such as today, tomorrow, or yesterday.
- Include source URLs in the final answer when available.

## Workflow

1. Decide whether the task is search/discovery or direct URL extraction.
2. Request the smallest useful call: one focused search query or one direct URL fetch.
3. Summarize the answer from retrieved content and include source URLs when available.
4. If a page cannot be fetched but the user needs rendered UI state, escalate to Browser MCP and explain why.

## Usage

- Load this skill for "search", "look up", "查", "查询", "天气", "新闻", "资料", "fetch this URL", or "read this web page" when the user does not need UI state.
- Prefer this skill over `browser-verification` unless the user asks to inspect what a browser page looks like or does.

## Guardrails

- Do not use Browser MCP for weather, news, general lookup, or direct page text extraction.
- Do not submit forms, click buttons, or transmit user data during retrieval.
- If a source requires login, paywall access, or JavaScript-only rendering, state the limitation and propose Browser MCP only if rendered state matters.
