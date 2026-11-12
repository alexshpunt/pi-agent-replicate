import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { snapshotSource } from "../../pi-extension/subagents/source-state.ts";
import { attachReplicaWork, captureReplicaLaunchPane, checkpointReplicaCompletion, cleanupReplicaWork, createReplicaWork, joinReplicaWork, readReplicaWork } from "../../pi-extension/subagents/replica-work.ts";
import { captureLaunchPaneOwnership } from "../../pi-extension/subagents/session-binding.ts";

test("settled App replica retires its own terminal and removes only the joined checkout", { skip: process.platform !== "linux", timeout: 60000 }, () => {
  const root = mkdtempSync(join(tmpdir(), "replicate-app-cleanup-")), repo = join(root, "repo"), checkout = join(root, "checkout"), store = join(root, "store");
  mkdirSync(repo); mkdirSync(store);
  const saved = { ...process.env };
  Object.assign(process.env, { HC_SESSION: randomUUID().slice(0, 8), XDG_CONFIG_HOME: join(root, "config"), XDG_STATE_HOME: join(root, "state"), XDG_DATA_HOME: join(root, "data"), XDG_RUNTIME_DIR: join(root, "runtime"), PI_HERDR_APP_MACHINE: "" });
  for (const key of ["HERDR_ENV", "HC_TERMINAL_ID", "HC_SOCKET", "HC_TERMINAL_SOCKET", "HC_SCOPE", "PI_TELEPORT_APP_CONTEXT"]) delete process.env[key];
  const hc = (...args: string[]) => JSON.parse(execFileSync("hc", args, { encoding: "utf8", timeout: 15000 }));
  const git = (...args: string[]) => execFileSync("git", args, { cwd: repo, encoding: "utf8" }).trim();
  let core: { pid: number; core: { id: string } } | undefined;
  try {
    core = hc("server", "start", "--json");
    git("init", "-q"); git("config", "user.name", "Test"); git("config", "user.email", "test@example.invalid");
    writeFileSync(join(repo, "file"), "base\n"); git("add", "file"); git("commit", "-qm", "base");
    const fork = snapshotSource(repo, join(store, "fork")), recordFile = join(store, "replica.json"), session = join(store, "child.jsonl");
    createReplicaWork(recordFile, "child", "parent", fork);
    git("worktree", "add", "-b", "replica", checkout, fork.commit);
    const parent = hc("run", "--bg", "--no-parent", "--cwd", repo, "--label", "herdr.space=parent", "--label", "herdr.tab=parenttab", "sh", "-i").address;
    const pane = hc("run", "--bg", "--no-parent", "--cwd", checkout, "--label", "herdr.space=child", "--label", "herdr.tab=childtab", "sh", "-i").address;
    const other = hc("run", "--bg", "--no-parent", "--cwd", repo, "sh", "-i").address;
    const terminal = hc("get", pane), owner = captureLaunchPaneOwnership(pane, terminal.pid); assert.ok(owner);
    process.env.HC_TERMINAL_ID = parent;
    const state = join(root, "app-state.json"), cli = join(root, "app-cli");
    writeFileSync(state, JSON.stringify({ visible: true, pane, other }));
    writeFileSync(cli, `#!/usr/bin/env node\nconst fs=require('fs'), f=${JSON.stringify(state)}, s=JSON.parse(fs.readFileSync(f)); if(process.argv[2]==='ls') console.log(JSON.stringify({spaces:s.visible||s.mod?[{id:'child',tabs:[...(s.visible?[{id:'childtab',terminals:[{terminal:s.pane,pane:'p1'},...(s.other?[{terminal:s.other,pane:'p2'}]:[])]}]:[]),...(s.mod?[{id:'modtab',terminals:[]}]:[])]}]:[]})); else if(process.argv[2]==='do'&&process.argv[3]==='terminal.park'){s.visible=false;fs.writeFileSync(f,JSON.stringify(s));console.log(JSON.stringify({pending:true,terminal:s.pane}));} else process.exit(1);\n`);
    chmodSync(cli, 0o755); process.env.PI_HERDR_APP_CLI = cli;
    attachReplicaWork(recordFile, { path: checkout, workspaceId: "child", paneId: pane, branch: "replica", baseRef: fork.commit, baseSha: fork.commit, manifestFile: join(store, "manifest") }, session);
    captureReplicaLaunchPane(recordFile, owner);
    writeFileSync(session, JSON.stringify({ type: "session", version: 3, id: "child", cwd: checkout }) + "\n");
    writeFileSync(join(checkout, "file"), "child work\n");
    checkpointReplicaCompletion(recordFile, checkout, session, { name: "child", task: "work", summary: "done", exitCode: 0, elapsed: 1 });
    assert.equal(joinReplicaWork(recordFile, repo).integration.status, "applied");
    assert.equal(cleanupReplicaWork(recordFile, repo), false);
    assert.equal(hc("get", other).state, "live"); assert.equal(hc("get", pane).state, "live");
    writeFileSync(state, JSON.stringify({ visible: true, pane }));
    writeFileSync(join(checkout, "file"), "later edit\n");
    assert.equal(cleanupReplicaWork(recordFile, repo), false);
    assert.equal(readFileSync(join(checkout, "file"), "utf8"), "later edit\n");
    assert.equal(hc("get", pane).state, "live");
    writeFileSync(state, JSON.stringify({ visible: true, pane, mod: true }));
    writeFileSync(join(checkout, "file"), "child work\n");
    assert.equal(cleanupReplicaWork(recordFile, repo), false);
    assert.equal(existsSync(checkout), true);
    assert.notEqual(readReplicaWork(recordFile).cleaned, true);
    writeFileSync(state, JSON.stringify({ visible: false, pane }));
    writeFileSync(join(checkout, "file"), "child work\n");
    assert.equal(cleanupReplicaWork(recordFile, repo), true);
    assert.equal(readFileSync(join(repo, "file"), "utf8"), "child work\n");
    assert.equal(existsSync(checkout), false); assert.equal(readReplicaWork(recordFile).cleaned, true);
    assert.equal(hc("get", parent).state, "live");
  } finally {
    delete process.env.HC_TERMINAL_ID;
    if (core) { const status = hc("server", "status", "--json"); assert.equal(status.pid, core.pid); assert.equal(status.core.id, core.core.id); hc("server", "stop", "--json"); }
    for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key];
    Object.assign(process.env, saved);
    rmSync(root, { recursive: true, force: true });
  }
});
