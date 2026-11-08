import assert from "node:assert/strict";
import { test } from "node:test";
import { retireAppTerminal, type AppRetirement } from "../pi-extension/subagents/app-retire.ts";

test("retires only the verified shell and resumes after an interrupted kill", () => {
  let live = true, visible = true, removed = false, allow = true, crash = true;
  let saved: AppRetirement | undefined;
  const calls: string[] = [];
  const operations = {
    coreIdentity: () => ({ id: "private-core", pid: 700, start: "123", bootId: "boot" }),
    terminal: () => removed ? undefined : ({ state: live ? "live" : "finished", pid: 900 }),
    foreground: () => ({ shellPid: 900, shellOwnsForeground: true, foregroundProcesses: [{ pid: 900, cwd: "/x", argv: ["sh"] }] }),
    isVisible: () => visible,
    park: () => { calls.push("park"); visible = false; },
    kill: () => { calls.push("kill"); live = false; if (crash) { crash = false; throw new Error("lost reply"); } },
    remove: () => { calls.push("remove"); removed = true; },
    owns: () => allow,
    save: (next: AppRetirement) => { saved = next; },
  };
  assert.throws(() => retireAppTerminal("t4", 900, undefined, operations));
  assert.deepEqual(calls, ["park", "kill"]);
  assert.ok(saved);
  allow = false; // The shell has exited; the saved core and terminal record now carry ownership.
  assert.equal(retireAppTerminal("t4", 900, saved, operations), true);
  assert.deepEqual(calls, ["park", "kill", "remove"]);
});

test("cancellation retires only the captured active processes and survives a lost kill reply", () => {
  let state: "live" | "finished" | "missing" = "live", visible = true, foreign = true;
  let saved: AppRetirement | undefined;
  const calls: string[] = [];
  const ops = {
    coreIdentity: () => ({ id: "core", pid: 100, start: "101", bootId: "boot" }),
    terminal: () => state === "missing" ? undefined : { state, pid: 900 },
    foreground: () => ({ shellPid: 900, shellOwnsForeground: false, foregroundProcesses: [{ pid: foreign ? 903 : 902, cwd: "/x", argv: ["pi"] }] }),
    isVisible: () => visible,
    park: () => { calls.push("park"); visible = false; },
    kill: () => { calls.push("kill"); state = "finished"; throw new Error("lost reply"); },
    remove: () => { calls.push("remove"); state = "missing"; },
    owns: () => true,
    save: (value: AppRetirement) => { saved = value; },
  };
  assert.equal(retireAppTerminal("t4", 900, undefined, ops, { cancelPids: [900, 902] }), false);
  assert.deepEqual(calls, []);
  foreign = false;
  assert.throws(() => retireAppTerminal("t4", 900, undefined, ops, { cancelPids: [900, 902] }));
  assert.ok(saved);
  assert.equal(retireAppTerminal("t4", 900, saved, ops, { cancelPids: [900, 902] }), true);
  assert.deepEqual(calls, ["park", "kill", "remove"]);
});
test("does not alter a terminal whose ownership or core has changed", () => {
  const calls: string[] = [];
  const operations = {
    coreIdentity: () => ({ id: "another-core", pid: 701, start: "124", bootId: "boot" }),
    terminal: () => ({ state: "live", pid: 901 }),
    foreground: () => { throw new Error("must not observe a foreign shell"); },
    isVisible: () => true,
    park: () => { calls.push("park"); }, kill: () => { calls.push("kill"); }, remove: () => { calls.push("remove"); },
    owns: () => false, save: () => {},
  };
  assert.equal(retireAppTerminal("t4", 900, undefined, operations), false);
  assert.equal(retireAppTerminal("t4", 900, { paneId: "t4", shellPid: 900, coreId: "private-core", corePid: 700, coreStart: "123", bootId: "boot" }, operations), false);
  assert.deepEqual(calls, []);
});
