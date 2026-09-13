# Documentation

## Active contracts

- [Worktree subagents](worktree-subagents.md) — isolation, retained state, review, and cleanup.
- [Public subagent tree API](public-subagent-tree-api.md) — package-root API and ownership contract.
- [Settled lifecycle contract](settled-lifecycle-contract.md) — completion and delivery semantics.

## Architecture decisions

- [ADR-0003](adr/0003-installable-role-packs.md) — installable custom role packs.
- [ADR-0008](adr/0008-adopt-pi-only-subagent-execution.md) — Pi-only child execution.
- [ADR-0009](adr/0009-durable-recursive-subagent-ownership.md) — durable recursive ownership.
- [ADR-0010](adr/0010-public-subagent-tree-registry.md) — public process-local tree registry.

Older workflow and command decisions were removed with the surfaces they described. Historical release notes remain in `CHANGELOG.md`.

## Background research

Files under [research](research/) are evidence and alternatives, not shipped contracts. When research conflicts with the README or an accepted ADR, the active contract wins.
