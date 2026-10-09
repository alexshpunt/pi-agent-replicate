# Project context

`pi-lpt-herdr-subagents` gives Pi agents a small asynchronous child-agent API backed by Herdr.

## Shipped surface

The extension exposes five model-facing tools:

- `subagent`
- `subagent_resume`
- `subagent_interrupt`
- `subagent_cancel`
- `subagents_list`

It registers no user commands. It has no bundled roles, review workflow, or orchestration skill.

The model-facing `subagent` tool requires an existing named role and hides `systemPrompt`. Bare launch support stays in the internal launcher and package-root API. Roles with `disable-model-invocation` stay hidden from listings but can still be launched by name.

## Runtime routing

A launch cannot choose a model or thinking level. Each value is resolved independently:

1. use the custom role frontmatter value when present;
2. otherwise inherit the parent value.

A role model must be one exact authenticated `provider/model-id`. Fallback lists are not supported.

## Roles

Roles come from project, global, or installed role-pack agent directories. Project roles override global roles, and global roles override role packs. Legacy roles that request an external CLI fail closed.

## Lifecycle

A launch is fire-and-forget. The tool returns an acknowledgement, then completion is delivered automatically. Parents do not poll. Nested ownership is durable, and an owner remains responsible until its descendants drain.

Session identity, not a file path or pane ID, owns delivery. A binding entry inside each session carries its durable store and child lifecycle settings. Teleport preserves that entry and session ID. The ownership index and lineage inboxes survive Pi and Herdr process replacement. Reopening the exact parent replays pending answers and starts a turn; a closed parent is never opened automatically. New-ID forks cannot claim the original answers. A delivery is acknowledged only after its exact result entry is saved, not merely queued. A pane can be cleaned up only while its recorded shell incarnation still owns it.

`caller_ping` reports nonterminal help. Interactive children can use `subagent_done` to settle explicitly. Resume, interrupt, cancel, and list operate on retained child state.

## Worktrees

`subagent` may opt into one isolated Herdr-managed Git worktree with `worktree: { branch, base? }`. The extension records ownership before Herdr creates resources. It retains the worktree after every outcome and never pushes, merges, or removes it.

The package-root API keeps the same ownership and runtime rules through `createSubagentTree` and `attachSubagentTree`.
