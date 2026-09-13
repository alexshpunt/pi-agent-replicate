# Pi LPT Herdr Subagents

An asynchronous subagent extension for [Pi](https://github.com/earendil-works/pi) that runs child Pi sessions in [Herdr](https://herdr.dev).

A parent agent can start a child in an ordinary Herdr pane or an isolated managed Git worktree. The tool returns immediately. When the child finishes, its complete result is delivered to the exact parent automatically.

## Install

```bash
pi install npm:pi-lpt-herdr-subagents
```

Start Pi inside Herdr, then restart Pi or run `/reload`.

## Agent-facing tools

The extension registers five tools:

| Tool | Purpose |
| --- | --- |
| `subagent` | Start a child Pi session asynchronously. |
| `subagent_resume` | Resume a saved child session in a new ordinary pane. |
| `subagent_interrupt` | Send Escape to the active child turn without closing the session. |
| `subagent_cancel` | End one child after pane absence and process exit are confirmed. |
| `subagents_list` | List custom project, global, and role-pack definitions. |

The extension registers no user commands. It ships no workflows, skills, or built-in roles.

### Start a child

```typescript
subagent({
  name: "auth-research",
  task: "Map the authentication flow and report relevant files and risks.",
});
```

For an isolated writing task:

```typescript
subagent({
  name: "auth-build",
  systemPrompt: "Implement only the approved change and report the commit SHA.",
  task: "Implement the approved authentication fix, test it, and commit it.",
  worktree: { branch: "fix/auth", base: "main" },
});
```

Use ordinary panes for read-only work. Use a unique worktree branch for each independent writing task. Worktree runs keep their workspace for review; the extension does not push, merge, or remove it.

### `subagent` parameters

| Parameter | Type | Description |
| --- | --- | --- |
| `name` | string | Required stable label shown in Herdr and the status widget. |
| `task` | string | Required child prompt. |
| `agent` | string | Optional custom role name. |
| `systemPrompt` | string | System prompt for a bare spawn. Named roles keep their own body. |
| `skills` | string | Comma-separated skills. Replaces the selected role's skill list. |
| `tools` | string | Comma-separated child tools. Replaces the selected role's tool list. |
| `cwd` | string | Child working directory, or source repository for a worktree launch. |
| `worktree` | object | Managed worktree with required `branch` and optional `base`. |
| `fork` | boolean | Start with the caller's conversation context. |
| `interactive` | boolean | Suppress autonomous stall/recovery wake-ups for user-driven children. |

A call cannot choose `model` or `thinking`.

## Runtime policy

Model and thinking are resolved independently:

1. Use the value from the selected role's frontmatter.
2. If the role omits it, inherit the value from the parent session.

Bare spawns inherit both values. Role models must be one exact authenticated `provider/model-id`. Model fallback lists and `config.json` model routing are not supported.

## Custom roles

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

## Lifecycle

`subagent` is fire-and-forget. Do not poll, sleep, tail session files, or repeatedly call `subagents_list` to check status.

A child ends through its lifecycle tools, a confirmed terminal failure, cancellation, or confirmed pane closure. Results include the child session path and an immutable Markdown result-file path. Nested children drain before their owner can deliver its own terminal result.

Autonomous children are supervised for crashes and stale inactivity. Interactive children are never killed by the stale watchdog. Durable ownership lets the extension restore pending delivery and ordinary-pane cleanup after restart.

Child-only lifecycle tools are registered only in child contexts:

- `subagent_done` records completion intent for an interactive child.
- `caller_ping` records a help request and returns it after descendants drain.

## Managed worktrees

`worktree: { branch, base? }` is opt-in on each `subagent` call.

- `cwd` selects the source repository.
- `base` resolves to an exact commit and defaults to committed `HEAD`.
- Parent uncommitted and untracked files are not copied.
- Ownership is recorded before Herdr resources are created.
- Success, failure, and help requests retain the workspace.
- Completion reports branch, commits, changed files, and clean/conflicted state.
- Unknown Git inspection results remain unknown; they are never guessed clean.

See [Worktree subagents](docs/worktree-subagents.md) for review and cleanup commands.

## Package-root API

Other Pi extensions can import the side-effect-free package root:

```typescript
import { createSubagentTree, attachSubagentTree } from "pi-lpt-herdr-subagents";
```

The tree API supports nested ownership, exact-parent reattachment, cancellation, worktree children, and one final callback. Its child runtime follows the same rule as `subagent`: role frontmatter, then parent inheritance. See [Public subagent tree API](docs/public-subagent-tree-api.md).

## Configuration

`config.json.example` contains status settings only:

```json
{
  "status": {
    "enabled": true,
    "quietThresholdMs": 120000
  }
}
```

`PI_SUBAGENT_QUIET_THRESHOLD_MS` overrides the quiet threshold for the current process. It must be a positive integer.

## Development

```bash
npm test
npm run lint
npm pack --dry-run
npx tsc --noEmit index.ts
node --check index.js
git diff --check
```

Run the isolated real-Pi and Herdr suite from inside Herdr:

```bash
npm run test:integration
```

See [RELEASING.md](RELEASING.md) for release checks.
