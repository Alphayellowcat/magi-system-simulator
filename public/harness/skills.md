---
id: registry.skills
version: 1
---

# Skills Registry

A skill is a versioned Markdown-first capability package. The harness expects each skill to expose a `SKILL.md` with front matter and operational instructions.

## Expected Shape

```text
skill-name/
  SKILL.md
  assets/
  scripts/
  references/
```

## Loading Rules

- Load a skill only when the user explicitly asks for it or the task clearly matches its description.
- Read `SKILL.md` first. Load referenced files narrowly.
- Prefer bundled scripts and assets over rewriting large logic.
- Skills may add tools or workflows, but they do not automatically grant execution permission.
- The local bridge can execute `skill.run` in `load` mode immediately. `script` mode requires `allowSkillScripts: true` in `.magi/config/bridge.json`.

## Installed Skill Slots

- harness-engineering: project-local `.magi/skills/harness-engineering/SKILL.md`
- mcp-tool-authoring: project-local `.magi/skills/mcp-tool-authoring/SKILL.md`
- browser-verification: project-local `.magi/skills/browser-verification/SKILL.md`
