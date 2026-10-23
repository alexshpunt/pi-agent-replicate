# Repository instructions for agents

## Purpose

This package replicates current Pi sessions asynchronously in Herdr. Replication clones use isolated source-snapshot worktrees and dedicated panes. Their host attempts join after successful settlement; conflicts and failed work stay recoverable. The retained internal launcher and package-root API also support isolated Herdr-managed Git worktrees.

Read `README.md`, `CONTEXT.md`, `docs/public-subagent-tree-api.md`, and `docs/worktree-subagents.md` before changing their contracts.

## Public surface

Keep exactly one model-facing tool: `replicate`. Each invocation creates a fresh copy in an isolated worktree. Do not register legacy tools, continuation choices or child completion/help tools. Do not add user commands, bundled roles, review workflows, or orchestration skills.

Replication inherits the parent's runtime, system prompt and active conversation. Put the parallel-copy identity, bounded assignment and summary requirement in a normal task message, never in the system prompt. Keep internal session references in host metadata. One invocation starts one fresh isolated copy. Keep task completion separate from integration outcome. Require a final summary, then close the clone after durable settlement and session-work drain. Wait for active tools, background completions, reported owned processes and descendants. Let the copy process completion results before returning; new work must cancel stale shutdown. Terminal model failures return error facts and a file of post-fork textual assistant answers, without tooling or hidden reasoning.

The retained internal and package-root launch paths still resolve custom role runtime values independently, then inherit the parent. Keep project, global, and installable role-pack discovery for those paths.

The extension is fire-and-forget. Never add polling guidance.

Explain replicate as parallel work, not delegation. Callers must already understand the task and intended working location, identify independent parts, specify the expected result, and keep separate work for themselves. No immediate waiting instead of doing the work. Later waiting after useful parallel work is fine.

Keep only `name` and `task` in the tool schema. The caller chooses a task-specific name in lowercase kebab-case; the runtime adds the parent origin to visible titles. Keep host mechanics out of the tool description, prompt guidelines and routine replies. Do not test prompt wording; verify schema and execution behavior through real requests and results.

## Code map

- `pi-extension/subagents/index.ts` — tools, discovery, launch/watch lifecycle, and delivery.
- `pi-extension/subagents/launch.ts` — Pi and worktree launch transaction.
- `pi-extension/subagents/lineage.ts` — durable recursive ownership.
- `pi-extension/subagents/runtime-routing.ts` — role-to-parent runtime resolution.
- `pi-extension/subagents/completion.ts`, `session.ts`, `subagent-done.ts` — completion evidence.
- `index.ts`, `index.js`, `index.d.ts` — package-root API; edit all three together.
- `test/` — unit and isolated Herdr integration coverage.

TypeScript modules under `pi-extension/subagents` that have JavaScript mirrors must stay aligned.

## Worktree rules

Preserve the retained API guarantees in `docs/worktree-subagents.md`: exact committed base, no parent dirty-file copy, manifest before Herdr creation, retained workspace, truthful Git inspection, and no automatic integration or cleanup. The model-facing replication path has its own snapshot/join contract.

Replication snapshots include tracked working files and nonignored untracked files, without changing the parent's HEAD or index. Only successful children attempt join; preserve parent work on conflict and retain failed worktrees. Clean successful worktrees only after durable integration, keeping session/checkpoint recovery. Serialize sibling joins. Internal callers that opt into isolated writing still use unique worktree branches.

## Documentation

Update every affected active contract with behavior changes. Keep durable intent in `CONTEXT.md` or an ADR; keep evidence and alternatives in research docs. Do not revive documentation for removed surfaces.

## Verification

Run only tests that check the changed behavior. Do not run full unit or integration suites unless the user explicitly asks. Run heavy checks on ZinPC, not the user's local machine. Give every test run a bounded timeout.

Also check the changed files with lint, inspect package contents with `npm pack --dry-run`, and run `git diff --check`.

Run diagnostics on every changed TypeScript file. If root `index.ts`, `index.js`, or `index.d.ts` changes, also run:

```bash
npx tsc --noEmit index.ts
node --check index.js
```

For lifecycle or Herdr changes, run the targeted real-Pi cases through the isolated runner with an explicit file list and test-name filter when needed. Never point tests at the user's persistent Herdr server.

Before committing, inspect status and diff, check package contents, remove generated artifacts, and confirm no accidental empty root directory exists.

## Release safety

Do not bump `package.json` unless the user explicitly requests a release. Never commit credentials, local config, sessions, plans, journals, or generated review artifacts.
