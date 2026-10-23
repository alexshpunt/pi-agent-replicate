import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { it } from "node:test";
import { SessionWork } from "../pi-extension/subagents/session-work.ts";

it("keeps a returned background terminal pending until its completion reaches the session", async () => {
  const work = new SessionWork("copy");
  work.toolStarted("outer/1");
  work.toolResult({ source: "shell:owned", status: "running", background: true, origin: { sessionId: "copy" } });
  work.toolEnded("outer/1");
  assert.equal(work.pending, true);
  // Reading a completed process must not beat the terminal's queued completion message.
  work.toolResult({ source: "shell:owned", status: "completed", background: true });
  assert.equal(work.pending, true);
  assert.equal(work.message({ customType: "terminal-completion", details: { sessions: [{ source: "shell:owned", status: "completed" }] } }), true);
  assert.equal(work.pending, false);
});

it("does not own another session's terminal or a completed foreground tool", () => {
  const work = new SessionWork("copy");
  work.toolResult({ source: "shell:other", status: "running", background: true, origin: { sessionId: "other" } });
  work.toolResult({ source: "shell:unowned-inspection", status: "running" }, true);
  work.toolResult({ source: "shell:done", status: "completed", background: false });
  assert.equal(work.pending, false);
  work.toolStarted("one"); work.toolStarted("two"); work.toolEnded("one");
  assert.equal(work.pending, true);
  work.toolEnded("two"); assert.equal(work.pending, false);
});

it("restores pending terminal completion across reload only for the exact session", () => {
  const work = new SessionWork("copy");
  work.toolResult({ source: "shell:owned", status: "running", background: true });
  assert.equal(new SessionWork("copy", work.snapshot()).pending, true);
  assert.equal(new SessionWork("other", work.snapshot()).pending, false);
});

it("waits for a reported owned child process and observes its real exit", { skip: process.platform !== "linux", timeout: 5_000 }, async () => {
  const child = spawn(process.execPath, ["-e", "process.stdin.resume()"], { stdio: ["pipe", "ignore", "ignore"] });
  const exit = once(child, "exit");
  const work = new SessionWork("copy");
  try {
    await work.trackProcesses({ pid: child.pid });
    assert.equal(work.pending, true);
    assert.deepEqual(await work.refreshProcesses(), []);
    child.stdin.end(); await exit;
    assert.deepEqual(await work.refreshProcesses(), [child.pid]);
    assert.equal(work.pending, false);
  } finally { if (child.exitCode === null) child.kill(); }
});

it("keeps non-process background requests alive and handles completion before a late receipt", () => {
  const work = new SessionWork("copy");
  work.toolResult({ requestId: "search", status: "running" });
  assert.equal(work.pending, true);
  assert.equal(work.message({ customType: "web-search:background-result", details: { requestId: "search", status: "failed" } }), true);
  work.toolResult({ requestId: "search", status: "running" });
  assert.equal(work.pending, false);
  work.message({ customType: "terminal-completion", details: { sessions: [{ source: "shell:fast", status: "completed" }] } });
  work.toolResult({ source: "shell:fast", status: "running", background: true });
  assert.equal(work.pending, false);
});
it("does not replace a terminal failure with a duplicate status-less PID completion", { skip: process.platform !== "linux", timeout: 5_000 }, async () => {
  const child = spawn(process.execPath, ["-e", "process.stdin.resume()"], { stdio: ["pipe", "ignore", "ignore"] });
  const exit = once(child, "exit"), work = new SessionWork("copy");
  try {
    work.toolResult({ source: "shell:failed", status: "running" });
    await work.trackProcesses({ source: "shell:failed", pid: child.pid });
    child.stdin.end(); await exit;
    work.message({ customType: "terminal-completion", details: { sessions: [{ source: "shell:failed", exitCode: 7 }] } });
    assert.deepEqual(await work.refreshProcesses(), []);
    assert.equal(work.pending, false);
  } finally { if (child.exitCode === null) child.kill(); }
});
it("keeps an observed descendant after its original parent exits", { skip: process.platform !== "linux", timeout: 5_000 }, async () => {
  const owner = spawn(process.execPath, ["-e", "const {spawn}=require('node:child_process');const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});console.log(String(child.pid));process.stdin.resume();process.stdin.on('end',()=>process.exit(0));"], { stdio: ["pipe", "pipe", "ignore"], env: { ...process.env, NODE_TEST_CONTEXT: undefined } });
  const exit = once(owner, "exit"), work = new SessionWork("copy");
  let leaf: number | undefined;
  try {
    const output = String((await once(owner.stdout, "data"))[0]);
    assert.match(output, /^\d+\r?\n$/, JSON.stringify(output));
    leaf = Number(output.trim());
    await work.trackProcesses({ pid: owner.pid });
    owner.stdin.end(); await exit;
    assert.deepEqual(await work.refreshProcesses(), [owner.pid]);
    assert.equal(work.pending, true, "the descendant still owns work after reparenting");
    process.kill(leaf, "SIGTERM");
    const deadline = Date.now() + 2_000;
    while (work.pending) {
      await work.refreshProcesses();
      assert.ok(Date.now() < deadline, "the descendant must stop");
      await new Promise(resolve => setTimeout(resolve, 10));
    }
  } finally {
    if (owner.exitCode === null) owner.kill();
    if (leaf) { try { process.kill(leaf, "SIGTERM"); } catch {} }
  }
});
it("does not declare a process on another boot or machine finished", { skip: process.platform !== "linux", timeout: 5_000 }, async () => {
  const child = spawn(process.execPath, ["-e", "process.stdin.resume()"], { stdio: ["pipe", "ignore", "ignore"] });
  const exit = once(child, "exit"), work = new SessionWork("copy");
  try {
    await work.trackProcesses({ pid: child.pid });
    const saved = work.snapshot(); saved.processes[0].boot = "another-machine";
    const moved = new SessionWork("copy", saved);
    assert.deepEqual(await moved.refreshProcesses(), []);
    assert.equal(moved.pending, true, "local PID reuse does not prove a remote job finished");
  } finally { child.stdin.end(); await exit; }
});
it("does not count Pi itself or a remote PID as a local job", async () => {
  const work = new SessionWork("copy");
  await work.trackProcesses({ pid: process.pid });
  await work.trackProcesses({ remote: { pid: process.pid, target: "worker" } });
  assert.equal(work.pending, false);
});
