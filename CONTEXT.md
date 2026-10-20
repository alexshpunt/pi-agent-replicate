# Project context

`pi-agent-replicate` lets an agent split independent work into copies of its current Pi session in Herdr.

## Shipped surface

The experimental model-facing surface is exactly one tool: `replicate({ name, task })` initially. A saved result adds `continuation` and `mode` to that same tool for its receiving session. One invocation creates one isolated continuation in a dedicated worktree and pane. It registers no user commands and ships no bundled roles, review workflows or orchestration skills.

The old role-based tools remain implemented but unregistered. The internal launcher and package-root tree API remain available for callers that need custom roles, bare children or managed worktrees. Their contracts are separate from replication.

## Replication

Replication is parallel work by copies of one agent, not delegation. The caller must already be at its intended working location and understand the task. It must identify independent parts, specify the copy's work and expected result, and continue a different part itself. Do not replicate while deciding the task or just to wait. Waiting after completing useful parallel work is allowed.

Use progressive disclosure. The initial description explains purpose and use, not Git, worktrees, checkpoints, delivery routing or host mechanics. Any usable saved result reveals its copy ID and recovery parameters. Restore that visibility from the exact receiver's durable result entries, not copied history in a new-ID session. Routine results retain a full summary without host reference footers; a failure or conflict explains the work problem and the available continuation.

A clone inherits the parent's model, thinking level, full system prompt, active tools and current active conversation, including the triggering user turn. Explicit CLI extensions follow it. The snapshot is captured before asynchronous launch work, so another turn or sibling tool result cannot change its context. Inherited pending tool calls are settled without executing them again.

Copied extension control state must not wake a parent-side background operation before the replica receives its own assignment. Keep the active conversation, not ownership of the parent's pending operations.

The bounded assignment, parallel-copy identity and required summary belong in a normal task message. Internal original-session references stay in host metadata. Replication must not change the system prompt or its cache prefix. There are no role, model, cwd, worktree or batch choices on this tool.

Each clone gets a source snapshot with tracked working files and nonignored untracked files. The host uses a private index and protected checkpoint refs without changing parent HEAD or staging. Ignored files are not copied. Worktrees isolate files, not shared processes, ports or databases. A clone can replicate its own independent work. It remains responsible until its descendants drain, then returns a nonempty final summary. No help or explicit completion tool is registered for clones.

The immediate parent's host saves completion, source and session evidence. Only successful children attempt a three-way join after their descendants drain. Sibling joins are serial, including across overlapping Pi incarnations. Costly replica checkpoint, join and cleanup work runs in a separate host process so it cannot block Pi's input or model loop. Durable ownership gates and existing journals recover interrupted work. Revalidate the original parent's location before file application and delivery. Task completion and integration are separate outcomes. A Git-clean join does not prove program correctness. Conflicts apply no child files; failures and empty summaries never auto-join partial work. Saved work remains available for manual resolution or continuation.

Every settled replica closes its owned pane and empty Herdr workspace after descendant drain and process exit, including failure and conflict. A continuation launch briefly waits for that cleanup gate instead of failing when the saved result arrives first. Failed or unjoined checkouts and saved sessions remain available for recovery. Applied worktrees are removed only after durable integration and checkpointing, verified ownership and process exit. Later edits or uncertain ownership prevent removal. Sessions and source checkpoints remain reconstructable. Closed parents defer successful joins until their exact session reopens.

Owned continuation IDs address the latest saved state only. `resume` keeps its session identity; `fork` starts an independent identity. Each attempt has distinct result artifacts. Neither can start on an active continuation, and unrelated parents cannot take ownership. Unjoined work carries its original join basis into recovery; applied work uses its last integrated checkpoint so old changes are not applied again. Terminal model failure is also terminal: report honest error facts and a file of every post-fork textual assistant answer. Exclude inherited answers, tool calls, tool results and hidden reasoning. Do not truncate the history. An empty required summary is a failure.

The caller must choose an explicit task-specific name in lowercase kebab-case for every invocation, including continuations. Reject missing or invalid names before launch. The runtime adds the immediate parent's origin as `task-name ← parent-name`, using the first nonempty parent session name, current Herdr pane name, or project directory name. Do not generate task names or copy numbers. Keep the same combined title in the child session, host surfaces, status, and result; internal IDs still own recovery and delivery.

New replica branches must show their origin and supplied task name as `replica/<origin>/<name>`, not an opaque copy ID. Use a lowercase ASCII origin slug, transliterating Cyrillic so Herdr does not drop the origin from the checkout directory. Reserve each branch atomically at its exact snapshot commit. Serialize allocation across the repository and check both branch names and flattened checkout names; occupied names get numeric suffixes without changing session titles or reusing another copy's source. Preserve parent HEAD and staging, and leave existing branches and recovery paths unchanged.

## Durable lifecycle

Replication is fire-and-forget. The caller gets an acknowledgement and later automatic delivery that starts a turn. Parents do not poll. Every fully stopped replica returns one truthful result, even after user input or Escape, and closes after durable settlement and descendant drain. Interruption and unsaved closure are failures with preserved post-fork answers and source work. Process loss does not automatically relaunch a replica; its immediate parent decides whether to continue it.

Routine supervision must leave the parent's input and tools responsive while copies run. Bound-session discovery uses its exact ownership index, attachment and same-session artifacts, not unrelated historical sessions. Reuse validated binding metadata and consume appended records without rereading whole conversations on every tick. File replacement, truncation and identity changes must invalidate that reuse; the cache is not ownership evidence on its own.

A missing or damaged answer-history boundary must not prevent terminal failure delivery or pane cleanup. Report the export error rather than guessing which answers belong to the copy. A failed session checkpoint must not prevent saving terminal facts and source work; retain the checkout, block integration and withhold continuation when no usable session checkpoint exists.

Normal settlement is immediate. Ten continuously idle seconds provide a safety net for missed handoff, not a limit on active work. Queued messages, requests, tools, retries, compaction, movement and descendant drain suspend that clock. A saved settlement can be retried after reload; missing settlement evidence cannot become success. The retained non-replica recovery and intervention policies remain separate.

Session identity, not a file path or pane ID, owns delivery. A binding inside each session carries its durable store and child settings. Teleport preserves that entry and session ID. The ownership index and lineage inboxes survive Pi and Herdr process replacement. Reopening the exact parent replays pending answers and starts a turn; a closed parent is never opened automatically. New-ID forks cannot claim the original answers. A delivery is acknowledged only after its exact result entry is saved, not merely queued. Cleanup requires the recorded shell incarnation to still own the pane.

Each tool-launched attempt also retains its actual execution ID and visible outer root from Pi's execution events. Persist both with launch metadata and delivery inboxes; do not recover them from ID syntax, names, paths, completion order or timing. Publish the root as `parentToolCallId` on delayed result/help messages so existing consumers can group searchable output without rewriting history. Explicit continuations replace the owner; automatic recovery preserves it. Missing ownership stays missing. This display linkage must not change result payloads, consumption, wakeups or source integration.

## Retained launch paths

For the internal launcher and package-root API, model and thinking resolve independently: use custom role frontmatter when present, otherwise inherit the parent. Role models must be exact authenticated `provider/model-id` values; fallback lists are unsupported.

Roles come from project, global or installed role-pack directories, in that priority order. Legacy external CLI roles fail closed. Non-replica children retain their help, explicit completion and interactive lifecycle behavior.

Managed worktrees remain opt-in on these retained paths. Ownership is recorded before Herdr creates resources. They use an exact committed base without copying parent dirty files, retain the workspace after every outcome, and never push, merge or remove it automatically. Replication has its own snapshot and automatic-join contract, separate from these retained worktrees.

The package-root API keeps these contracts through `createSubagentTree` and `attachSubagentTree` without registering model-facing tools.
