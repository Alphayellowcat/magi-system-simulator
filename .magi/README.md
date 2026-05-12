# MAGI Local Harness

This directory contains local harness state and machine-specific runtime wiring.

## Layout

- `skills/`: project-local Codex-style skills. Each skill should contain `SKILL.md`.
- `mcp/servers.json`: local MCP server registry. Ignored by Git because it may contain machine-specific commands, paths, or credentials.
- `config/bridge.json`: local bridge runtime settings. Ignored by Git.
- `state/`: local sessions, memories, runtime settings, and edited harness documents. Ignored by Git.
- `audit/`: append-only JSONL session audit logs. Ignored by Git.
- `artifacts/`: local tool artifacts such as Browser MCP screenshots. Ignored by Git.

The repository defaults live in `public/harness/`. Edited runtime copies live in `state/documents.json`.
