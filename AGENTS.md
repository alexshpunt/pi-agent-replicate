# Repository instructions for agents

## Purpose

This package replicates current Pi sessions asynchronously in Herdr. Replication clones use dedicated panes in the same checkout. The retained internal launcher and package-root API also support isolated Herdr-managed Git worktrees.

Read `README.md`, `CONTEXT.md`, `docs/public-subagent-tree-api.md`, and `docs/worktree-subagents.md` before changing their contracts.

## Public surface

Keep exactly one model-facing tool: `replicate({ task })`. Do not register the retained legacy tools or expose child completion/help tools to replication clones. Do not add user commands, bundled roles, review workflows, or orchestration skills.

Replication inherits the parent's runtime, system prompt and active conversation. Put clone identity and its bounded assignment in a normal task message, never in the system prompt. One invocation creates one clone in the same checkout. Require a final summary, then close the clone after durable settlement and descendant drain. Terminal model failures return error facts and a file of post-fork textual assistant answers, without tooling or hidden reasoning.

The retained internal and package-root launch paths still resolve custom role runtime values independently, then inherit the parent. Keep project, global, and installable role-pack discovery for those paths.

The extension is fire-and-forget. Never add polling guidance.

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

Preserve the guarantees in `docs/worktree-subagents.md`: exact committed base, no parent dirty-file copy, manifest before Herdr creation, retained workspace, truthful Git inspection, and no automatic integration or cleanup.

Replication clones share the caller's checkout and do not create worktrees. Keep overlapping edits sequential. Internal callers that opt into isolated writing still use unique worktree branches.

## Documentation

Update every affected active contract with behavior changes. Keep durable intent in `CONTEXT.md` or an ADR; keep evidence and alternatives in research docs. Do not revive documentation for removed surfaces.

## Verification

For normal changes:

```bash
npm test
npm run lint
npm pack --dry-run
git diff --check
```

Run diagnostics on every changed TypeScript file. If root `index.ts`, `index.js`, or `index.d.ts` changes, also run:

```bash
npx tsc --noEmit index.ts
node --check index.js
```

For lifecycle or Herdr changes, run `npm run test:integration` through the isolated runner. Never point tests at the user's persistent Herdr server.

Before committing, inspect status and diff, check package contents, remove generated artifacts, and confirm no accidental empty root directory exists.

## Release safety

Do not bump `package.json` unless the user explicitly requests a release. Never commit credentials, local config, sessions, plans, journals, or generated review artifacts.
