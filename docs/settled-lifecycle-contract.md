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

A queued self-reload is unfinished work. The acknowledgement before reload is not a terminal answer, and the stopped-replica timer stays suspended until reload continues the session or reports that it was blocked. An old runtime must not publish completion after shutdown, even if its descendant wait finishes later.

The retained non-replica lifecycle is unchanged: autonomous clean or empty boundaries can record terminal intent after the last descendant result; provider errors and aborts keep those children open.

Manual and automatic context compaction are active child work. `session_before_compact` protects the child from stale recovery until `session_compact` or `session_compact_failed` ends that state. Compaction never publishes or repeats a parent result.

## One terminal result

A child publishes only when it reaches a terminal lifecycle outcome, such as auto-exit, `subagent_done`, cancellation, confirmed pane loss, or recovery failure.

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

Replicas do not automatically restart after process loss or inactivity. Their parent receives a failure and decides whether to continue the saved copy. Normal settlement reports immediately. Ten continuous seconds with Pi idle and no pending messages, movement or undrained descendants retry a missed completion. A saved settlement checkpoint survives reload; without settlement evidence, this safety net reports failure and preserves the answers. Active requests, tools, retries and compaction do not count as stopped time.

Retained non-replica recovery is bounded to three attempts across crash and stale causes. An exhausted child is not killed, resumed or re-delivered on later watchdog passes.
A recovery watcher starts only after the replacement registers its own session and pane. The old closed pane must not become a manual-cancellation result for the new process.

## Descendants and exact-parent binding

A child drains only after its terminal outcome reaches its exact immediate-parent inbox and all descendants drain recursively. Failed inbox publication has no timeout and is never rerouted. A pending session inbox stays bound to the stable parent session ID until that exact session returns, even through a changed file path or pane.

Lineage identity belongs to the launched Pi session. A child lifecycle starts only after the runtime opens that session's persisted child binding. Reload startup checks, shell commands and test runners may inherit its environment variables, but that does not let them publish completion, update its activity or take ownership of its descendants. In particular, closing a no-session startup check must not report the live replica as closed.

A public `SubagentTree` owner is different. Its callbacks process child results inside the tree runtime. The tree result still waits for all reserved descendants, but ordinary model-facing `subagent_result` delivery follows the one-terminal-result rule above.
