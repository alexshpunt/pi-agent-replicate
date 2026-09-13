# Repository instructions for agents

## Purpose

This package launches asynchronous Pi child agents only in Herdr. Ordinary children use dedicated panes. Writing children may opt into isolated Herdr-managed Git worktrees.

Read `README.md`, `CONTEXT.md`, `docs/public-subagent-tree-api.md`, and `docs/worktree-subagents.md` before changing their contracts.

## Public surface

Keep exactly five model-facing tools: `subagent`, `subagent_resume`, `subagent_interrupt`, `subagent_cancel`, and `subagents_list`. Do not add user commands, bundled roles, review workflows, or orchestration skills.

Launch calls cannot select `model` or `thinking`. Runtime comes independently from custom role frontmatter, then the parent. Keep project, global, and installable role-pack discovery.

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

Use ordinary panes for read-only work and unique worktree branches for independent writing. Keep overlapping writing tasks sequential.

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
