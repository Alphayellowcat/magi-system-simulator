---
name: harness-engineering
description: Use when improving the MAGI harness itself: persona prompts, shared/private memory, council protocol, action approval, trace design, runtime capability manifests, settings/storage, or agent orchestration.
---

# Harness Engineering

Use this skill when the task is about changing how MAGI thinks, remembers, plans, approves, or executes.

## Workflow

1. Separate editable harness state from authoritative runtime state.
2. Treat persona, memory, council, tools, skills, and MCP docs as Markdown state, but do not let stale Markdown override live runtime capability data.
3. For tool access, prefer a host-provided Runtime Tool Manifest: bridge status, available skill ids, configured MCP servers, and relevant tool names.
4. Keep council behavior explicit: independent persona analysis, meeting/cross-examination, synthesis, pending actions, clarification requests, execution stream, and trace.
5. For code changes, inspect files through filesystem MCP when available before proposing edits.
6. Preserve user edits and runtime state. Avoid replacing whole Markdown documents unless explicitly asked.

## Validation

- Confirm low-risk read actions execute without approval.
- Confirm mutating actions become pending approvals.
- Confirm stale memories cannot make MAGI deny a live bridge/MCP capability.
- Run TypeScript and build checks when code changes are made.
