# Pi LPT Herdr Subagents

An experimental session-replication extension for [Pi](https://github.com/earendil-works/pi) in [Herdr](https://herdr.dev).

An agent can run a defined part of its task in parallel with another copy of itself while continuing a different part. The copy's result returns automatically to the original session.

## Install

```bash
pi install npm:pi-lpt-herdr-subagents
```

Start Pi inside Herdr, then restart Pi or run `/reload`.

## Agent-facing tool

The extension registers exactly one tool and no user commands:

```typescript
replicate({ name: "check-auth-risks", task: "Check authentication risks while I implement the settings change. Return concrete findings with file references." });
```

Use it only from a task-ready state: the agent is already in the intended working location, understands its task, and has identified independent parts that can run in parallel. Before calling, it must know the copy's assignment, the expected result, and the separate work it will continue itself.

This is parallel work by one agent, not a tool for handing off a task. Do not replicate while still deciding the task, its scope, or where to work. If the next step would be waiting for the copy, do the work yourself. After finishing real parallel work, the original may end its turn and wait for automatic delivery. Do not poll.

The initial schema requires `name` and `task`. A saved result reveals its copy ID and adds `continuation` and `mode` to the same tool. Reload restores those choices only in the session that received the result; a new-ID copy does not inherit them. Routine replies omit host paths and checkpoint details. A work problem is explained when it occurs.

The caller must choose a task-specific `name` in lowercase kebab-case, such as `check-auth-risks`. The runtime adds the origin: `check-auth-risks ← Settings`. The origin comes from the parent's session name, then its current Herdr pane name, then the project directory name. The same combined title appears in the copy's session, Herdr workspace and pane, active status, and result. There is no automatic numbering. Internal IDs remain separate.

Git branches use `replica/<origin>/<name>`, for example `replica/settings/check-auth-risks`. The origin is lowercased and made safe for a path; Cyrillic is transliterated (`Настройки` becomes `nastroiki`). Herdr uses the branch to name the checkout directory, such as `replica-nastroiki-check-auth-risks`. Repeated or simultaneous launches reserve separate branches with `-2`, `-3`, and so on, without changing the displayed session title. These suffixes also avoid different origin/task pairs that would produce the same checkout directory. Existing branches and worktrees are not renamed.

## Replication runtime

The following details describe the implementation, not instructions added to the agent's prompt.

Each call copies the current active conversation, including the current user turn. It inherits the model, thinking level, full system prompt and active tools. Explicit CLI extensions follow the copy too. The bounded assignment and summary requirement are sent as a normal task message, without changing the system prompt.

A fresh call requires `name` and `task`. There are no role, model, cwd, worktree or batch choices. Each copy gets tracked working files and nonignored untracked files from the moment of launch. The snapshot does not change the parent's HEAD or staging. Ignored files, dependencies and builds are not copied. Worktrees isolate source files, not shared processes, ports or databases.

After a saved result discloses an owned continuation ID, the same tool can continue the latest saved source and conversation:

```typescript
replicate({ name: "continue-auth-check", continuation: "saved-id", mode: "resume", task: "Continue with this new information." });
replicate({ name: "try-auth-alternative", continuation: "saved-id", mode: "fork", task: "Try an independent continuation." });
```

`resume` preserves the saved session identity; `fork` creates a new one. Both use fresh per-attempt artifacts and an isolated worktree. Only the immediate parent can address its continuation. Active attempts cannot be continued concurrently. Removed successful worktrees can be rebuilt from their saved checkpoints. Arbitrary historical checkpoint selection is not supported.

A copy can call `replicate` for an independent part of its assignment. It must wait for its own copies and return a nonempty final summary. The runtime delivers that summary and closes its pane and empty Herdr workspace after descendants drain and the process exits. Failed and conflicted copies close too; their files and saved sessions stay available for recovery. Copies do not get `caller_ping` or `subagent_done`.

The former `subagent`, `subagent_resume`, `subagent_interrupt`, `subagent_cancel` and `subagents_list` implementations remain internal and are not registered by default. The package-root API is unchanged. The package ships no workflows, skills or built-in roles.

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

## Lifecycle

`replicate` is fire-and-forget. Do not poll, sleep, tail session files or check panes to wait for it. Continue independent work or end your turn until automatic delivery starts the next turn.

Host metadata retains the saved session and immutable Markdown result-file paths. Routine model-visible results carry the copy's summary and saved-copy choice, not those internal references. Terminal model failures report error facts; host metadata also retains a separate file containing every post-fork textual assistant answer in order. That file excludes the original's answers, tool calls, tool results and hidden reasoning. Answers are not truncated. An empty required summary is a failure, not success.

Every fully stopped replica reports and closes, including after user input or Escape. An interrupted copy reports interruption; an unsaved close or process loss reports failure with preserved answers, not success or an automatic restart. The parent can choose a continuation from the returned result.

Normal settlement reports immediately. A ten-second safety net retries a missed handoff only while Pi is truly idle, with no queued work, movement or undrained descendants. Active tools, requests, retries and compaction are not subject to that deadline. Durable ownership restores pending results, join plans and cleanup after restart. The retained non-replica API keeps its existing recovery and interactive policies.

The binding is saved inside the Pi session and follows its stable session ID through Teleport. A new file, cwd, process, or pane does not change the receiver. A fork with a new session ID does not inherit pending answers. Children restore their own lifecycle and follow their moved immediate parent, including nested launches. A move suspends source-side delivery and completion while the replacement binds; an abandoned child handoff has a bounded recovery gate.

Ownership and current locations are indexed under `$PI_CODING_AGENT_DIR/subagent-sessions` (default: `~/.pi/agent/subagent-sessions`). The session carries this store path through moves. Answers stay in durable lineage inboxes until their exact result entry is saved in the parent session. When the parent is closed, nothing opens it automatically: reopening that session restores observers, replays pending answers, and wakes its agent. A Herdr restart does not erase the store. An interrupted active child uses bounded recovery or reports failure; unfinished computation is not a saved answer.

Keep the binding store, session artifacts, and saved sessions together when backing up or moving to another machine. Pane IDs alone are never permission to close a pane after a restart.

The retained API's non-replica children may receive lifecycle tools:

- `subagent_done` records completion intent for an interactive child.
- `caller_ping` records a help request and returns it after descendants drain.

## Managed worktrees

Replication always creates a snapshot worktree. The immediate parent's host saves the completed child's source and session, then attempts a three-way join against the original snapshot. Sibling joins run serially through durable ownership gates. Checkpointing, Git joins and owned cleanup run in background host processes, not Pi's input thread. The host revalidates the original session before applying files and delivering its result. Parent HEAD and staging stay unchanged. A clean Git join means no detected text conflict, not that the combined program is correct.

Task completion and integration are separate outcomes: `applied`, `conflict`, `blocked`, or `not-attempted`. Conflicts do not apply any of the child's files to the parent. Failed or empty-summary children never auto-join partial work. Their worktrees stay available, and the parent gets the continuation ID and checkpoint. Continuing unjoined work includes its outstanding changes; continuing already-applied work joins only new changes.

Successful worktrees are removed only after durable integration and source/session checkpointing, with ownership, process-exit and unchanged-source checks. Unknown ownership or later edits keep the worktree. Saved sessions and GC-protected source refs remain recoverable. If the parent is closed, successful integration waits for its exact session to reopen; no replacement parent is opened automatically.

The package-root API and retained internal role launcher have a separate opt-in worktree contract:

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

The tree API supports nested ownership, exact-parent reattachment, cancellation, worktree children, and one final callback. Its child runtime retains role frontmatter, then parent inheritance; this is separate from session replication. See [Public subagent tree API](docs/public-subagent-tree-api.md).

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

Run selected isolated real-Pi and Herdr cases from inside Herdr:

```bash
npm run test:integration -- test/integration/replication.test.ts
```

For a manual TUI check with a deterministic provider, set `PI_INTEGRATION_TUI_DIR` to a fresh ignored directory and `PI_INTEGRATION_IDE_ENTRY` to the current IDE source entry. Run only this case with the intended Pi binary on `PATH`:

```bash
node --experimental-strip-types test/integration/run-isolated.ts \
  --test-name-pattern='renders an active isolated replica' test/integration/replication.test.ts
```

The case reloads Pi and records the loaded IDE in `runtime.json`. The applied and failed cases each write to their own subdirectory. Use its `pane.json` to attach a read-only observer to the private Herdr endpoint. Capture the active pane, then create `release-child` in the inspection directory. Capture the delivered result, then create `finish` so the runner can clean up. Both observation gates time out after five minutes. Do not use the user's persistent Herdr server.

See [RELEASING.md](RELEASING.md) for release checks.
