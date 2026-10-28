# Settled lifecycle contract

This document defines how child turns become one parent result. The TypeScript source for settled outcome shapes is `pi-extension/subagents/settled-contract.ts`.

## Settled turns stay local

A settled assistant entry is still classified for child control:

- `clean`: non-empty assistant text with no final provider error.
- `empty`: a settled assistant entry with no usable text.
- `error`: `stopReason: "error"`.
- `intentional-abort`: `stopReason: "aborted"` after the parent recorded an interrupt request.
- `unexpected-abort`: `stopReason: "aborted"` without an interrupt request.

These boundaries do not publish parent results. A persistent child can settle many times while it remains open. Its earlier answers, empty turns, errors, and aborts stay in its own session.

For a replica, a clean nonempty response can record terminal intent only after the last descendant result is processed. Earlier responses stay local. A terminal provider error, Escape, an empty required summary or an unsaved close records failure, saves completion evidence and closes after descendant drain. User input does not suppress replica completion. A saved final response without settlement evidence is preserved as history, never promoted to success. Its original receives error facts and a file of all post-fork textual assistant answers, excluding inherited answers, tooling and hidden reasoning.

If history export fails, the terminal result reports that error instead of retrying completion forever. An unknown inherited-answer boundary never authorizes exporting the whole conversation. If the session file cannot be checkpointed, terminal facts and source checkpointing still proceed. The checkout stays available, integration is blocked without advertising a saved-copy continuation.

A queued self-reload is unfinished work. The acknowledgement before reload is not a terminal answer, and the stopped-replica timer stays suspended until reload continues the session or reports that it was blocked. An old runtime must not publish completion after shutdown, even if its descendant wait finishes later.

A stopped model does not imply finished session work. Replicas wait for active tools, background terminal completion messages, pending background request receipts, reported live Linux descendant PIDs and their observed children, and their own replicas. The copy processes completion messages before returning. New work invalidates an older shutdown decision, including one already waiting for descendants. The idle safety timer cannot bypass this guard. Terminal completion remains authoritative for its exit status; observing the same PID exit must not replace it with a status-less duplicate. A successful terminal deletion retires only that terminal's receipt because deletion suppresses its completion message. Independently tracked live processes and other work still block closure.

Search completions committed as atomic `custom_message` boundary entries drain their matching request before final settlement, even when Pi emits no `message_start`. A passive `web-search:cancelled` custom entry with `{ requestId, status: "cancelled", parentToolCallId? }` releases that request without waking a stopped model. A successful `wait_for_web_searches` also drains the known search set captured when that wait started, including searches cancelled during a provider retry. Failed waits, unrelated requests and searches launched after the wait started remain pending.

Receipt and process ownership persists for the exact session through reload. Unreported daemons, unsupported native process identities and remote jobs without completion receipts are not discoverable by this guard. It does not adopt unrelated processes or idle runtime helpers.

The settled handler returns its finalization promise. Pi must see the shutdown request before it checks that settled boundary; saving a result or starting detached finalization is not proof that the Pi process exited.

The retained non-replica lifecycle is unchanged: autonomous clean or empty boundaries can record terminal intent after the last descendant result; provider errors and aborts keep those children open.

Manual and automatic context compaction are active child work. `session_before_compact` protects the child from stale recovery until `session_compact` or `session_compact_failed` ends that state. Compaction never publishes or repeats a parent result.

## Failed replica startup

The parent records the allocated pane's shell incarnation before starting Pi. If extension loading or an earlier launch step fails, cleanup can use that launch record without waiting for child session initialization. Only a verified owned idle shell is closed; a changed boot, reused shell or live process blocks that cleanup. Keep failed source and session evidence.

A terminal marker is process-exit evidence only after the replica process has stopped. Revalidate it after sidecar and diagnostic-read races. Report available startup diagnostics, not unrelated warnings or an inherited parent answer. A native launch error already saved in the exact parent counts as its outcome and is not replayed as another automatic result. A warning without process failure does not terminate a copy.

## One terminal result

A child publishes only when it reaches a terminal lifecycle outcome, such as auto-exit, cancellation, confirmed pane loss, or recovery failure. No model-facing completion or help tool is registered.

The terminal path:

1. reads the latest child result;
2. waits for every recursive descendant to drain;
3. writes one immutable result file and one durable inbox entry;
4. materializes that inbox in the exact parent session once;
5. records delivery before cleanup; and
6. removes the child from active supervision as soon as delivery is recorded.

The stable terminal delivery ID is the child ID prefixed with `terminal:`. Delivery uses an exclusive durable claim. A successful send is acknowledged once. A send that throws remains retryable. A send that Pi only queued — the streaming parent has not written it to its session yet — is never repeated: the claim stays held until the parent session holds the record, so one result cannot become many copies. Compaction, reload, restored watchers, and later parent tool calls cannot materialize an acknowledged delivery again.

Old pending `settled` inbox entries are acknowledged without being sent. This prevents an upgrade or restored session from exposing an intermediate response after the terminal-only rule is active.

Cleanup is separate from delivery. An ordinary child pane closes after delivery. A worktree child keeps its review workspace. A delivered child leaves the widget immediately; a rejected Herdr close retries a few times with backoff and then stops with a delivery-log record. Its result is not sent again.

Replicas do not automatically restart after process loss or inactivity. Their parent receives a failure with available answer/error facts and can create a fresh copy. Normal settlement reports only after session work drains. Ten continuous seconds with Pi idle and no pending messages, movement or undrained descendants retry a missed completion. A saved settlement checkpoint survives reload; without settlement evidence, this safety net reports failure and preserves the answers. Active requests, tools, retries and compaction do not count as stopped time.

Retained non-replica recovery is bounded to three attempts across crash and stale causes. An exhausted child is not killed, resumed or re-delivered on later watchdog passes.
A recovery watcher starts only after the replacement registers its own session and pane. The old closed pane must not become a manual-cancellation result for the new process.

## Descendants and exact-parent binding

A child drains only after its terminal outcome reaches its exact immediate-parent inbox and all descendants drain recursively. Failed inbox publication has no timeout and is never rerouted. A pending session inbox stays bound to the stable parent session ID until that exact session returns, even through a changed file path or pane.

Lineage identity belongs to the launched Pi session. A child lifecycle starts only after the runtime opens that session's persisted child binding. Reload startup checks, shell commands and test runners may inherit its environment variables, but that does not let them publish completion, update its activity or take ownership of its descendants. In particular, closing a no-session startup check must not report the live replica as closed.

A public `SubagentTree` owner is different. Its callbacks process child results inside the tree runtime. The tree result still waits for all reserved descendants, but ordinary model-facing `subagent_result` delivery follows the one-terminal-result rule above.
