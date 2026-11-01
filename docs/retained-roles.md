# Retained role launcher

This reference applies to the package-root API and retained internal launcher, not the model-facing `replicate` tool.

## Retained runtime policy

Model and thinking are resolved independently:

1. Use the value from the selected role's frontmatter.
2. If the role omits it, inherit the value from the parent session.

This role policy applies only to the retained internal launcher and package-root API. `replicate` uses the parent runtime without resolving a role. Bare spawns remain supported by those retained paths. They inherit both values. Role models must be one exact authenticated `provider/model-id`. Model fallback lists and `config.json` model routing are not supported.

## Custom roles for the retained API

The package has no built-in roles. Add roles in one of these places:

| Source | Path |
| --- | --- |
| Project | `.pi/agents/<name>.md` |
| Global | `$PI_CODING_AGENT_DIR/agents/<name>.md` (normally `~/.pi/agent/agents/<name>.md`) |
| Role pack | An installed Pi package registered through the role discovery event |

Priority is project, then global, then role pack. Duplicate role-pack names are rejected.

Example:

```markdown
---
name: security-reviewer
description: Reviews a bounded change for security problems
model: provider/exact-model-id
thinking: high
tools: read, bash
spawning: false
auto-exit: true
---

Review only the requested change. Report concrete findings with file references.
```

Useful frontmatter fields:

- `name`, `description`
- `model`, `thinking`
- `tools`, `skills`, `deny-tools`
- `spawning`, `allow-self-spawn`
- `auto-exit`, `interactive`
- `session-mode`: `standalone`, `lineage-only`, or `fork`
- `cwd`
- `system-prompt`: `append` or `replace`
- `disable-model-invocation`

Requested skills are saved in the child's conversation once. Reloading or resuming that conversation reuses the saved skills instead of adding another initialization message.

Definitions that request an external `cli` fail before Herdr creates resources.

### Role packs

A Pi package can register one absolute Markdown file or a directory of direct `.md` children through this event:

```typescript
pi.events.on(
  "pi-herdr-subagents:roles:discover:v1",
  (request: { apiVersion: number; register(path: string): void }) => {
    if (request.apiVersion === 1) request.register(absoluteRolesDirectory);
  },
);
```

A role-pack extension must remove its listener on `session_shutdown`.
