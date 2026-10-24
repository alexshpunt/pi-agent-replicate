import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it } from "node:test";
import { acknowledgeReportedLaunchFailure, appendLineageEvent, hasLineageEvent, reduceLineage, registerLineage } from "../pi-extension/subagents/lineage.ts";

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "reported-replica-launch-"));
  const node = registerLineage({ artifactDir: dir, nodeId: "failed", parentSessionId: "parent", parentSessionFile: join(dir, "parent.jsonl"), launchKind: "worktree" });
  return { dir, node, state: () => reduceLineage(node.rootDir).nodes.get("failed")!, close: () => rmSync(dir, { recursive: true, force: true }) };
}

it("does not acknowledge an already reported launch while a descendant remains undrained", () => {
  const f = fixture();
  try {
    registerLineage({ artifactDir: f.dir, nodeId: "descendant", parentNodeId: "failed", inheritedRootDir: f.node.rootDir, inheritedRootId: f.node.rootId, launchKind: "fresh" });
    assert.throws(() => acknowledgeReportedLaunchFailure(f.node, "dispatch failed"), /descendant/i);
    assert.equal(f.state().terminalDelivered, undefined);
    assert.equal(f.state().cleanupPending, undefined);
    appendLineageEvent(f.node.rootDir, "terminal:descendant", "terminal", "descendant", { outcome: "error" });
    appendLineageEvent(f.node.rootDir, "terminal-delivered:descendant", "terminal_delivered", "descendant", { deliveryId: "terminal:descendant" });
    acknowledgeReportedLaunchFailure(f.node, "dispatch failed");
    assert.equal(f.state().terminalDelivered, "terminal:failed");
    assert.equal(f.state().cleanupPending, true);
  } finally { f.close(); }
});

it("keeps a failed acknowledgement retryable and records cleanup before delivery", () => {
  const f = fixture();
  try {
    const publish: typeof appendLineageEvent = (...args) => args[2] === "terminal_delivered" ? false : appendLineageEvent(...args);
    assert.throws(() => acknowledgeReportedLaunchFailure(f.node, "dispatch failed", publish), /publish/i);
    assert.equal(f.state().terminalDelivered, undefined);
    assert.equal(hasLineageEvent(f.node.rootDir, "cleanup-pending:failed", "cleanup_pending"), true);
    acknowledgeReportedLaunchFailure(f.node, "dispatch failed");
    acknowledgeReportedLaunchFailure(f.node, "dispatch failed");
    assert.equal(f.state().terminalDelivered, "terminal:failed");
    assert.equal(f.state().cleanupPending, true);
  } finally { f.close(); }
});

it("restores a metadata-incomplete failed replica without resending its native error", { timeout: 6000 }, async () => {
  const { default: extension } = await import("../pi-extension/subagents/index.ts");
  const { seedSessionBinding, registerSessionLineage, writeBindingFile } = await import("../pi-extension/subagents/session-binding.ts");
  const { writeFileSync } = await import("node:fs");
  const f = fixture(), parentFile = f.node.parentSessionFile!, storeDir = join(f.dir, "store"), workFile = join(f.dir, "failed.json");
  const handlers = new Map<string, Function[]>(), messages: unknown[] = [];
  const ctx: any = { cwd: f.dir, hasUI: false, isIdle: () => true, hasPendingMessages: () => false,
    ui: { notify() {}, setWidget() {} }, sessionManager: { getSessionFile: () => parentFile, getSessionId: () => "parent", getSessionDir: () => f.dir,
      getBranch: () => [{ type: "message", message: { role: "toolResult", toolCallId: "failed-call", isError: true } }] } };
  const api: any = { events: { on() { return () => {}; }, emit() {} },
    on(name: string, callback: Function) { const list = handlers.get(name) ?? []; list.push(callback); handlers.set(name, list); },
    registerTool() {}, registerCommand() {}, registerShortcut() {}, registerMessageRenderer() {}, getAllTools: () => [],
    sendMessage(value: unknown) { messages.push(value); } };
  const emit = async (name: string, event: unknown = {}) => { for (const handler of handlers.get(name) ?? []) await handler(event, ctx); };
  try {
    writeFileSync(parentFile, JSON.stringify({ type: "session", version: 3, id: "parent", cwd: f.dir }) + "\n");
    seedSessionBinding(parentFile, { version: 1, storeDir });
    registerSessionLineage(storeDir, "parent", f.node.rootDir);
    writeBindingFile(workFile, { version: 1, id: "failed", parentSessionId: "parent", fork: { commit: "base" }, joinBase: "base", launchError: "allocation failed", launchErrorToolCallId: "failed-call", integration: { status: "not-attempted" } });
    appendLineageEvent(f.node.rootDir, "metadata:failed:reserved", "launch_metadata", "failed", { name: "failed", task: "work", replication: true, replicaWorkFile: workFile });
    extension(api);
    await emit("session_start");
    const deadline = Date.now() + 4000;
    while ((!f.state().terminalDelivered || f.state().cleanupPending !== false) && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 20));
    assert.equal(f.state().terminalDelivered, "terminal:failed");
    assert.equal(f.state().cleanupPending, false);
    assert.deepEqual(messages, [], "the original native error is already the parent outcome");
    await emit("session_start");
    assert.deepEqual(messages, [], "replay must not send a second result");
  } finally { await emit("session_shutdown", { reason: "reload" }); f.close(); }
});
