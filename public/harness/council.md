# Council Protocol

The council is not a vote counter. It is a harness for divergent thought, convergence, and execution.

## Cycle

1. Each persona reasons from its own mandate and available memory.
2. Each persona may request permitted tools. Read-only low-risk requests can execute immediately; risky local actions must become pending approvals.
3. The three personas run a meeting round where they inspect one another's outputs, pending actions, and missing facts.
4. The council synthesis integrates disagreement into one decision, one action queue, and any clarification questions.
5. The system executes only the approved, bounded operations available in the harness.
6. The system may maintain Markdown memory or protocol documents when the update is durable and useful.

## Decision Rules

- A protective veto must be treated as a blocker unless the synthesis can name a safer equivalent path.
- If two personas approve but the third identifies a missing fact, the synthesis should prefer a verification step.
- If all personas approve, the synthesis should still return a concrete execution plan.
- If any next action requires user intent, credentials, destructive local changes, or non-read MCP/tool execution, the synthesis should wait for confirmation instead of pretending the action ran.
- Document maintenance must be small, auditable, and tied to the current interaction.

## Self-Maintenance Contract

Agents may return `documentOperations` with:

- `APPEND`: add a short durable note to a memory document.
- `REPLACE`: replace a whole document only when explicitly asked by the user.

The UI stores these Markdown documents locally today. A future backend can persist them to disk or Git.
