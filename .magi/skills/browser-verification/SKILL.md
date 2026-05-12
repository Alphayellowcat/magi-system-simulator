---
name: browser-verification
description: Use when verifying MAGI or another local web UI in a real browser: page loading, screenshots, console/runtime errors, form flows, streaming output, approval buttons, and responsive layout checks.
---

# Browser Verification

Use this skill when the task requires checking the running UI rather than only reading code.

## Workflow

1. Confirm the dev server URL and bridge status.
2. Open or reload the local page.
3. Capture the cheapest useful signal first: DOM snapshot, visible text, console errors, or screenshot.
4. Verify the specific workflow under test:
   - Ops settings save/test connection.
   - Live execution stream updates.
   - Council meeting section renders.
   - Pending action approval/rejection buttons update trace.
   - Clarification buttons move questions back into input.
5. Record failures with the exact visible state and the likely code surface.

## Guardrails

- Do not transmit secrets or submit external forms during verification.
- For local-only UI checks, prefer read-only inspection first.
- When browser automation is unavailable, report that separately from application health.
