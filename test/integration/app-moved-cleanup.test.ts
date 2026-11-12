import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { runReplicaBackground } from "../../pi-extension/subagents/replica-background.ts";
import { attachReplicaWork, captureReplicaLaunchPane, createReplicaWork } from "../../pi-extension/subagents/replica-work.ts";
import { snapshotSource } from "../../pi-extension/subagents/source-state.ts";
import { registerLineage } from "../../pi-extension/subagents/lineage.ts";
import { captureLaunchPaneOwnership, writeBindingFile } from "../../pi-extension/subagents/session-binding.ts";

test("cleans a moved App shell and its original shell without closing the parent", { skip: process.platform !== "linux", timeout: 60000 }, async () => {
  const root = mkdtempSync(join(tmpdir(), "replicate-app-moved-")), repo = join(root, "repo"), checkout = join(root, "checkout"), store = join(root, "store");
  mkdirSync(repo); mkdirSync(store);
  const lineage = registerLineage({ artifactDir: root, nodeId: "child" }).rootDir;
  mkdirSync(join(lineage, "locations"), { recursive: true });
  const saved = { ...process.env };
  Object.assign(process.env, { HC_SESSION: randomUUID().slice(0, 8), XDG_CONFIG_HOME: join(root, "config"), XDG_STATE_HOME: join(root, "state"), XDG_DATA_HOME: join(root, "data"), XDG_RUNTIME_DIR: join(root, "runtime"), PI_HERDR_APP_MACHINE: "" });
  for (const key of ["HERDR_ENV", "HC_TERMINAL_ID", "HC_SOCKET", "HC_TERMINAL_SOCKET", "HC_SCOPE", "PI_TELEPORT_APP_CONTEXT"]) delete process.env[key];
  const hc = (...args: string[]) => JSON.parse(execFileSync("hc", args, { encoding: "utf8", timeout: 15000 }));
  const git = (...args: string[]) => execFileSync("git", args, { cwd: repo, encoding: "utf8" });
  let core: { pid: number; core: { id: string } } | undefined;
  try {
    core = hc("server", "start", "--json");
    git("init", "-q"); git("config", "user.name", "Test"); git("config", "user.email", "test@example.invalid");
    writeFileSync(join(repo, "file"), "base\n"); git("add", "file"); git("commit", "-qm", "base");
    const fork = snapshotSource(repo, join(store, "fork")), file = join(store, "replica.json");
    createReplicaWork(file, "child", "parent", fork); git("worktree", "add", "-b", "replica", checkout, fork.commit);
    const parent = hc("run", "--bg", "--no-parent", "--cwd", repo, "--label", "herdr.space=parent", "--label", "herdr.tab=parenttab", "sh", "-i").address;
    const original = hc("run", "--bg", "--no-parent", "--cwd", checkout, "--label", "herdr.space=original", "--label", "herdr.tab=otab", "sh", "-i").address;
    const moved = hc("run", "--bg", "--no-parent", "--cwd", checkout, "--label", "herdr.space=moved", "--label", "herdr.tab=mtab", "sh", "-i").address;
    const originalOwner = captureLaunchPaneOwnership(original, hc("get", original).pid), movedOwner = captureLaunchPaneOwnership(moved, hc("get", moved).pid); assert.ok(originalOwner && movedOwner);
    process.env.HC_TERMINAL_ID = parent;
    const state = join(root, "state.json"), cli = join(root, "app-cli");
    writeFileSync(state, JSON.stringify([{ id: "original", tab: "otab", terminal: original }, { id: "moved", tab: "mtab", terminal: moved }]));
    writeFileSync(cli, `#!/usr/bin/env node\nconst fs=require('fs'), f=${JSON.stringify(state)}, s=JSON.parse(fs.readFileSync(f)); if(process.argv[2]==='ls')console.log(JSON.stringify({spaces:s.map(x=>({id:x.id,tabs:[{id:x.tab,terminals:[{terminal:x.terminal,pane:'p'+x.terminal}]}]}))}));else if(process.argv[2]==='do'&&process.argv[3]==='terminal.park'){const t=JSON.parse(process.argv[4]).terminal;fs.writeFileSync(f,JSON.stringify(s.filter(x=>x.terminal!==t)));console.log(JSON.stringify({pending:true,terminal:t}));}else process.exit(1);\n`);
    chmodSync(cli, 0o755); process.env.PI_HERDR_APP_CLI = cli;
    attachReplicaWork(file, { path: checkout, workspaceId: "original", paneId: original, branch: "replica", baseRef: fork.commit, baseSha: fork.commit, manifestFile: join(store, "manifest") }, join(store, "session.jsonl"));
    captureReplicaLaunchPane(file, originalOwner);
    const locationFile = join(lineage, "locations", "child.json");
    const location = { version: 1, sessionId: "child", sessionFile: join(root, "missing.jsonl"), pid: 2147483647, processStart: "0", paneId: moved, shellPid: movedOwner.shellPid, shellStart: movedOwner.shellStart, cwd: checkout, childNodeId: "child", childRootDir: lineage };
    const request = { operation: "cleanup" as const, file, parentCwd: repo, surface: moved, child: { rootDir: lineage, nodeId: "child" } };
    writeBindingFile(locationFile, { ...location, shellStart: "wrong-incarnation" });
    assert.equal((await runReplicaBackground(request)).cleaned, false);
    assert.equal(hc("get", moved).state, "live"); assert.equal(hc("get", original).state, "live");
    writeBindingFile(locationFile, location);
    const result = await runReplicaBackground(request);
    assert.equal(result.cleaned, true);
    assert.equal(hc("get", parent).state, "live");
    assert.throws(() => hc("get", moved)); assert.throws(() => hc("get", original));
    assert.equal(existsSync(checkout), true);
  } finally {
    delete process.env.HC_TERMINAL_ID;
    if (core) { const status = hc("server", "status", "--json"); assert.equal(status.pid, core.pid); assert.equal(status.core.id, core.core.id); hc("server", "stop", "--json"); }
    for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key];
    Object.assign(process.env, saved); rmSync(root, { recursive: true, force: true });
  }
});
