# Pi Agent Replicate

`CONTEXT.md` holds the product intent and the contracts of the `replicate` tool. Read it before changing the tool, its schema or how it is presented. Read the matching document before changing its contract:

- `docs/settled-lifecycle-contract.md`: how child turns settle into one parent result.
- `docs/worktree-subagents.md`: worktree snapshots, joins and retained worktrees.
- `docs/public-subagent-tree-api.md`: the package-root API.
- `docs/adr/`: past decisions; don't revive removed surfaces.

Keep exactly one model-facing tool, `replicate`, with only `name` and `task` in its schema.

## Code map

- `pi-extension/subagents/index.ts`: tools, discovery, launch/watch lifecycle and delivery.
- `pi-extension/subagents/launch.ts`: Pi and worktree launch transaction.
- `pi-extension/subagents/lineage.ts`: durable recursive ownership.
- `pi-extension/subagents/runtime-routing.ts`: role-to-parent runtime resolution.
- `pi-extension/subagents/completion.ts`, `session.ts`, `subagent-done.ts`: completion evidence.
- `index.ts`, `index.js`, `index.d.ts`: package-root API. Edit all three together.

TypeScript modules under `pi-extension/subagents` that have JavaScript mirrors must stay aligned.

## Checks

- If `index.ts`, `index.js` or `index.d.ts` changes, run `npx tsc --noEmit index.ts` and `node --check index.js`.
- Inspect package contents with `npm pack --dry-run`.
- Run lifecycle and Herdr cases through `test/integration/run-isolated.ts` with an explicit file list (see `README.md`). Never point tests at the user's persistent Herdr server.
