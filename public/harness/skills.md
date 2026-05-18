---
id: registry.skills
version: 1
---

# Skills Registry

A skill is a versioned Markdown-first capability package. The harness expects each skill to expose a `SKILL.md` with front matter and operational instructions.

## Skill Contract

Every skill should make dispatch and safe use obvious from the document itself:

- `description`: one precise routing sentence that says when to load the skill.
- `Capability`: what the skill can help the agent do.
- `Boundaries`: what the skill must not be used for, and when another skill/tool route is better.
- `Implementation Route`: which host tools, MCP servers, files, scripts, or APIs actually perform the work.
- `Workflow`: the normal step-by-step operating procedure.
- `Usage`: trigger phrases and pairing rules for other skills.
- `Guardrails` or `Validation`: safety checks and expected proof that the skill worked.

A skill is not an execution permission. It is a readable capability contract plus operating procedure. Execution still goes through tools, MCP, settings, approval gates, and audit.

## Progressive Disclosure

MAGI follows the same broad pattern as Codex skills:

1. Front matter `name` and `description` stay in the runtime skill list.
2. `SKILL.md` is loaded only after a task matches the skill.
3. `actions.json` is optional machine-readable routing metadata for deterministic tool calls.
4. `scripts/`, `references/`, and `assets/` are loaded or executed only when the selected workflow needs them.

`actions.json` must stay declarative. It may describe triggers, argument extraction, script path, risk, preferred owner, and dedupe behavior. It must not bypass the harness approval, permission, trace, or audit systems.

## Expected Shape

```text
skill-name/
  SKILL.md
  actions.json
  assets/
  scripts/
  references/
```

## Loading Rules

- Load a skill only when the user explicitly asks for it or the task clearly matches its description.
- Read `SKILL.md` first. Load referenced files narrowly.
- Prefer bundled scripts and assets over rewriting large logic.
- Skills may add tools or workflows, but they do not automatically grant execution permission.
- Machine-readable actions are suggestions to the harness, not raw authority. The Tool Access Matrix, risk assessment, approval queue, and audit log still apply.
- The local bridge can execute `skill.run` in `load` mode immediately. `script` mode requires `allowSkillScripts: true` in `.magi/config/bridge.json`.

## Installed Skill Slots

- harness-engineering: project-local `.magi/skills/harness-engineering/SKILL.md`
- mcp-tool-authoring: project-local `.magi/skills/mcp-tool-authoring/SKILL.md`
- market-quote: project-local `.magi/skills/market-quote/SKILL.md`
- web-retrieval: project-local `.magi/skills/web-retrieval/SKILL.md`
- browser-verification: project-local `.magi/skills/browser-verification/SKILL.md`

## Retrieval vs Browser Verification

- Use `market-quote` plus its `quote.current` skill action for current quotes of US/HK/A-share stocks and BTC.
- Use `web-retrieval` plus `web.search.tavily` / `web.fetch` for weather, news, factual lookup, documentation discovery, search results, and direct URL text extraction.
- Use `browser-verification` plus Browser MCP for local UI inspection, current page DOM, screenshots, visual layout checks, streaming output verification, click/type interaction, and form workflows.
- Do not route retrieval-only questions to Browser MCP just because a browser server is online.
