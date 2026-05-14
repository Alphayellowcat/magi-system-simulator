# Council Protocol

The council is not a vote counter or a meeting simulator. It is a harness for divergent thought, convergence, and execution.

Action is not a single phase. Any persona, meeting round, or synthesis pass may request permitted tools whenever a tool can clarify the task, verify a fact, inspect local state, or prepare an implementation. Discussion should expose uncertainty; it must not replace available low-risk action.

## Cycle

1. Each persona reasons from its own mandate and available memory, and may request permitted tools immediately.
2. Read-only low-risk requests can execute without approval; risky local actions must become pending approvals.
3. Before and during council, personas may request additional tools when another persona exposes a missing fact.
4. The synthesis pass may still request final verification before answering.
5. The council synthesis integrates tool results, disagreement, pending actions, and clarification questions into one user-facing answer.
6. The system executes only the approved, bounded operations available in the harness.
7. The system may maintain Markdown memory or protocol documents when the update is durable and useful.

## Decision Rules

- A protective veto must be treated as a blocker unless the synthesis can name a safer equivalent path.
- If two personas approve but the third identifies a missing fact, the synthesis should prefer an available verification tool before asking the user.
- If all personas approve, the synthesis should still return a concrete execution plan.
- If any next action requires user intent, credentials, destructive local changes, or non-read MCP/tool execution, the synthesis should wait for confirmation instead of pretending the action ran.
- Document maintenance must be small, auditable, and tied to the current interaction.

## Self-Maintenance Contract

Agents may return `documentOperations` with:

- `APPEND`: add a short durable note to a memory document.
- `REPLACE`: replace a whole document only when explicitly asked by the user.

The UI stores these Markdown documents locally today. A future backend can persist them to disk or Git.
