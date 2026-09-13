# ADR-0009: Durable recursive subagent ownership

- Status: Accepted

## Context

A child may launch descendants and then settle before they do. Process-local maps cannot preserve correct ownership through extension reloads or independent child processes.

## Decision

Publish immutable lineage events under the parent session artifacts. Register each child before Herdr creates its pane or worktree. Each node records its parent node and parent Pi session sink.

A node drains only after its own terminal result has been delivered and every recursive descendant has drained. Inbox materialization uses durable claims and acknowledgements so recovery can avoid duplicate delivery. Cancellation becomes terminal only after pane absence and process exit are proven.

Lineage identity belongs to the launched Pi process. Unrelated subprocesses that inherit environment variables do not become descendants.

## Consequences

- Nested ownership survives extension reloads and independent processes.
- A parent cannot report final completion while a descendant remains undrained.
- Results route to the exact parent Pi session.
- Corrupt, cyclic, or unattributable state fails closed instead of guessing.
- Cleanup is separate from delivery, so retained evidence remains inspectable.
