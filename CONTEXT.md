# Project context

`pi-lpt-herdr-subagents` lets an agent split independent work into copies of its current Pi session in Herdr.

## Shipped surface

The experimental model-facing surface is exactly one tool: `replicate({ task, continuation?, mode? })`. One invocation creates one isolated continuation in a dedicated worktree and pane. It registers no user commands and ships no bundled roles, review workflows or orchestration skills.

The old role-based tools remain implemented but unregistered. The internal launcher and package-root tree API remain available for callers that need custom roles, bare children or managed worktrees. Their contracts are separate from replication.

## Replication

A clone inherits the parent's model, thinking level, full system prompt, active tools and current active conversation, including the triggering user turn. Explicit CLI extensions follow it. The snapshot is captured before asynchronous launch work, so another turn or sibling tool result cannot change its context. Inherited pending tool calls are settled without executing them again.

Clone identity, the original session reference and its bounded assignment belong in a normal task message. They must not change the system prompt or its cache prefix. There are no role, model, cwd, worktree or batch choices on this tool.

Each clone gets a source snapshot with tracked working files and nonignored untracked files. The host uses a private index and protected checkpoint refs without changing parent HEAD or staging. Ignored files are not copied. Worktrees isolate files, not shared processes, ports or databases. A clone can replicate its own independent work. It remains responsible until its descendants drain, then returns a nonempty final summary. No help or explicit completion tool is registered for clones.

The immediate parent's host saves completion, source and session evidence. Only successful children attempt a three-way join after their descendants drain. Sibling joins are serial. Task completion and integration are separate outcomes. A Git-clean join does not prove program correctness. Conflicts apply no child files; failures and empty summaries never auto-join partial work. Saved work remains available for manual resolution or continuation.

Applied worktrees are cleaned only after durable integration and checkpointing, verified ownership and process exit. Later edits or uncertain ownership prevent removal. Sessions and source checkpoints remain reconstructable. Closed parents defer successful joins until their exact session reopens.

Owned continuation IDs address the latest saved state only. `resume` keeps its session identity; `fork` starts an independent identity. Each attempt has distinct result artifacts. Neither can start on an active continuation, and unrelated parents cannot take ownership. Unjoined work carries its original join basis into recovery; applied work uses its last integrated checkpoint so old changes are not applied again. Terminal model failure is also terminal: report honest error facts and a file of every post-fork textual assistant answer. Exclude inherited answers, tool calls, tool results and hidden reasoning. Do not truncate the history. An empty required summary is a failure.

## Durable lifecycle

Replication is fire-and-forget. The caller gets an acknowledgement and later automatic delivery that starts a turn. Parents do not poll. Autonomous copies retain the bounded crash and stale-recovery policy.

Session identity, not a file path or pane ID, owns delivery. A binding inside each session carries its durable store and child settings. Teleport preserves that entry and session ID. The ownership index and lineage inboxes survive Pi and Herdr process replacement. Reopening the exact parent replays pending answers and starts a turn; a closed parent is never opened automatically. New-ID forks cannot claim the original answers. A delivery is acknowledged only after its exact result entry is saved, not merely queued. Cleanup requires the recorded shell incarnation to still own the pane.

## Retained launch paths

For the internal launcher and package-root API, model and thinking resolve independently: use custom role frontmatter when present, otherwise inherit the parent. Role models must be exact authenticated `provider/model-id` values; fallback lists are unsupported.

Roles come from project, global or installed role-pack directories, in that priority order. Legacy external CLI roles fail closed. Non-replica children retain their help, explicit completion and interactive lifecycle behavior.

Managed worktrees remain opt-in on these retained paths. Ownership is recorded before Herdr creates resources. They use an exact committed base without copying parent dirty files, retain the workspace after every outcome, and never push, merge or remove it automatically. Replication has its own snapshot and automatic-join contract, separate from these retained worktrees.

The package-root API keeps these contracts through `createSubagentTree` and `attachSubagentTree` without registering model-facing tools.
