---
name: harness-engineering
description: Use when improving the MAGI harness itself: persona prompts, shared/private memory, council protocol, action approval, trace design, runtime capability manifests, settings/storage, or agent orchestration.
---

# Harness Engineering

Use this skill when the task is about changing how MAGI thinks, remembers, plans, approves, or executes.

## Capability

- Design or modify persona prompts, shared/private memory, council protocol, tool policy, approval flow, trace/audit design, runtime manifests, settings storage, and agent orchestration.
- Translate product-level harness ideas into concrete code and Markdown state changes.
- Diagnose whether a behavior problem comes from prompt state, runtime manifest, tool permissions, storage, UI, or bridge execution.

## Boundaries

- This skill does not execute tools by itself. It describes how the harness should route and govern execution.
- Do not treat editable Markdown as more authoritative than live runtime status. Runtime bridge, MCP tools, and actual settings win over stale docs.
- Do not replace persona/memory/council documents wholesale unless the user explicitly asks for a reset or rewrite.
- Do not use this skill for generic web lookup, browser screenshots, or MCP protocol authoring unless the task is about harness integration.

## Implementation Route

- Read code and Markdown state through filesystem MCP or local files before proposing edits.
- Use `mcp.call` for filesystem inspection when MAGI itself is acting at runtime.
- Use `skill.run` with `mode=load` to inspect related skill instructions.
- Route risky local mutation through pending approvals in the product, not direct model text.

## Workflow

1. Separate editable harness state from authoritative runtime state.
2. Treat persona, memory, council, tools, skills, and MCP docs as Markdown state, but do not let stale Markdown override live runtime capability data.
3. For tool access, prefer a host-provided Runtime Tool Manifest: bridge status, available skill ids, configured MCP servers, and relevant tool names.
4. Keep council behavior explicit: independent persona analysis, meeting/cross-examination, synthesis, pending actions, clarification requests, execution stream, and trace.
5. For code changes, inspect files through filesystem MCP when available before proposing edits.
6. Preserve user edits and runtime state. Avoid replacing whole Markdown documents unless explicitly asked.

## Usage

- Load this skill when the user says MAGI is "only talking", "not acting", "needs harness engineering", "needs better memory/persona/tool design", or asks to change council/trace/approval/storage behavior.
- Produce concrete implementation steps and modify the repo when the user asks to build the harness behavior.

## Validation

- Confirm low-risk read actions execute without approval.
- Confirm mutating actions become pending approvals.
- Confirm stale memories cannot make MAGI deny a live bridge/MCP capability.
- Run TypeScript and build checks when code changes are made.
