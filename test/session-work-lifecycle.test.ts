import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it } from "node:test";
import lifecycle from "../pi-extension/subagents/subagent-done.ts";
import { seedSessionBinding } from "../pi-extension/subagents/session-binding.ts";

async function fixture(run: (test: { emit: (name: string, value?: any) => Promise<void>; file: string; shutdowns: () => number; busy: (value: boolean) => void; messages: any[] }) => Promise<void>) {
  const dir = mkdtempSync(join(tmpdir(), "replica-session-work-")), file = join(dir, "copy.jsonl");
  const prompt = join(dir, "prompt.txt"); writeFileSync(prompt, "inherited system prompt");
  writeFileSync(file, JSON.stringify({ type: "session", version: 3, id: "copy", cwd: dir }) + "\n");
  const environment = { PI_SUBAGENT_SESSION: file, PI_SUBAGENT_AUTO_EXIT: "1", PI_SUBAGENT_REPLICATION: "1", PI_SUBAGENT_ID: "copy", PI_SUBAGENT_REPLICATION_PROMPT_FILE: prompt };
  const old = Object.fromEntries(Object.keys(environment).map(key => [key, process.env[key]]));
  Object.assign(process.env, environment);
  seedSessionBinding(file, { version: 1, storeDir: join(dir, "store"), child: { lineage: { rootDir: join(dir, "lineage"), rootId: "copy", nodeId: "copy", launchKind: "fork" }, environment } });
  const handlers = new Map<string, Function[]>(), branch: any[] = [], messages: any[] = [];
  let shutdowns = 0, busy = false;
  const ctx: any = { cwd: dir, isIdle: () => !busy, hasPendingMessages: () => false, shutdown: () => { shutdowns++; }, ui: { setWidget() {}, notify() {} }, sessionManager: { getSessionFile: () => file, getSessionId: () => "copy", getBranch: () => branch } };
  const pi: any = { events: {}, on(name: string, handler: Function) { const list = handlers.get(name) ?? []; list.push(handler); handlers.set(name, list); return () => {}; }, appendEntry(customType: string, data: unknown) { branch.push({ type: "custom", customType, data }); }, sendMessage(value: unknown) { messages.push(value); }, registerTool() {}, registerShortcut() {}, getAllTools: () => [], getActiveTools: () => [], setActiveTools() {} };
  const emit = async (name: string, value: any = {}) => { for (const handler of handlers.get(name) ?? []) await handler(value, ctx); };
  try { lifecycle(pi, ctx); await emit("before_agent_start", {}); await run({ emit, file, shutdowns: () => shutdowns, busy: value => { busy = value; }, messages }); }
  finally { await emit("session_shutdown", { reason: "reload" }); for (const [key, value] of Object.entries(old)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } rmSync(dir, { recursive: true, force: true }); }
}
const answer = (text: string) => ({ messages: [{ id: text, role: "assistant", stopReason: "stop", content: [{ type: "text", text }] }] });

it("does not close a settled replica before its background terminal completion is processed", { timeout: 5_000 }, async () => {
  await fixture(async test => {
    await test.emit("tool_execution_start", { toolCallId: "background", toolName: "bash" });
    await test.emit("tool_result", { toolCallId: "background", toolName: "bash", details: { source: "shell:job", background: true, status: "running", origin: { sessionId: "copy" } } });
    await test.emit("tool_execution_end", { toolCallId: "background", toolName: "bash" });
    await test.emit("agent_end", answer("before job completes")); await test.emit("agent_settled");
    await new Promise(resolve => setTimeout(resolve, 25));
    assert.equal(test.shutdowns(), 0); assert.equal(existsSync(test.file + ".exit"), false);
    await test.emit("message_start", { message: { role: "custom", customType: "terminal-completion", details: { sessions: [{ source: "shell:job", status: "completed" }] } } });
    await test.emit("before_agent_start", {});
    await test.emit("agent_end", answer("job result inspected")); await test.emit("agent_settled");
    await new Promise(resolve => setTimeout(resolve, 25));
    assert.equal(test.shutdowns(), 1);
  });
});

it("does not adopt an inspected runtime helper as a launched session job", { timeout: 5_000 }, async () => {
  const helper = spawn(process.execPath, ["-e", "process.stdin.resume()"], { stdio: ["pipe", "ignore", "ignore"] });
  const exit = once(helper, "exit");
  try {
    await fixture(async test => {
      await test.emit("tool_execution_start", { toolCallId: "inspect", toolName: "read" });
      await test.emit("tool_result", { toolCallId: "inspect", toolName: "read", details: { pid: helper.pid } });
      await test.emit("tool_execution_end", { toolCallId: "inspect", toolName: "read" });
      await test.emit("agent_end", answer("inspection finished")); await test.emit("agent_settled");
      await new Promise(resolve => setTimeout(resolve, 25));
      assert.equal(test.shutdowns(), 1);
    });
  } finally { helper.stdin.end(); await exit; }
});
it("cancels an old shutdown when a new run starts before its drain completes", { timeout: 5_000 }, async () => {
  await fixture(async test => {
    test.busy(true);
    await test.emit("agent_end", answer("old answer")); await test.emit("agent_settled");
    await test.emit("before_agent_start", {});
    test.busy(false);
    await new Promise(resolve => setTimeout(resolve, 30));
    assert.equal(test.shutdowns(), 0); assert.equal(existsSync(test.file + ".exit"), false);
    await test.emit("agent_end", answer("new answer")); await test.emit("agent_settled");
    await new Promise(resolve => setTimeout(resolve, 25)); assert.equal(test.shutdowns(), 1);
  });
});
