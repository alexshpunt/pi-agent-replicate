import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { appCore } from "../../pi-extension/subagents/herdr-app.ts";
import { listHerdrWorktrees } from "../../pi-extension/subagents/herdr.ts";
import { closePane, createSubagentPane, createSubagentWorktree, interruptPane, runScriptInPane, shellQuote, waitForShellReady } from "../../pi-extension/subagents/terminal.ts";

const root = process.env.PI_INTEGRATION_HERDR_RUN_DIR!;
async function until(check: () => boolean): Promise<void> {
  const end = Date.now() + 15_000;
  while (Date.now() < end) { if (check()) return; await new Promise(resolve => setTimeout(resolve, 50)); }
  assert.fail("The native terminal did not reach its expected state.");
}
function inventory(): any[] {
  const value = appCore(["ls", "--all"]);
  return Array.isArray(value) ? value : value.terminals;
}

test("native interrupt sends Escape to the actual foreground program", { timeout: 30_000 }, async () => {
  const ready = join(root, "escape-ready"), received = join(root, "escape-received");
  const pane = createSubagentPane("native-escape");
  try {
    await waitForShellReady(pane);
    const code = `const fs=require('node:fs');process.stdin.setRawMode(true);process.stdin.resume();process.stdin.once('data',data=>{fs.writeFileSync(${JSON.stringify(received)},data);process.exit(0)});fs.writeFileSync(${JSON.stringify(ready)},String(process.pid));`;
    runScriptInPane(pane, `${shellQuote(process.execPath)} -e ${shellQuote(code)}`, { scriptPath: join(root, "escape.sh") });
    await until(() => existsSync(ready));
    const pid = Number(readFileSync(ready, "utf8"));
    assert.ok(existsSync(`/proc/${pid}`));
    interruptPane(pane);
    await until(() => existsSync(received));
    assert.deepEqual(readFileSync(received), Buffer.from([27]));
    await until(() => !existsSync(`/proc/${pid}`));
  } finally { closePane(pane); }
});

test("native close refuses changed ownership without killing the terminal", { timeout: 30_000 }, async () => {
  const pane = createSubagentPane("native-owner-guard");
  await waitForShellReady(pane);
  const before = appCore(["get", pane]);
  const birth = readFileSync(`/proc/${before.pid}/stat`, "utf8").split(") ").at(-1)!.split(" ")[19];
  try {
    appCore(["label", pane, "herdr.tab=foreign-tab"]);
    assert.throws(() => closePane(pane));
    const after = appCore(["get", pane]);
    assert.equal(after.pid, before.pid);
    assert.equal(after.state, "live");
    assert.equal(after.labels["herdr.tab"], "foreign-tab");
    assert.equal(readFileSync(`/proc/${after.pid}/stat`, "utf8").split(") ").at(-1)!.split(" ")[19], birth);
  } finally {
    appCore(["label", pane, "herdr.tab=" + before.labels["herdr.tab"]]);
    closePane(pane);
  }
  await until(() => !inventory().some(terminal => terminal.address === pane));
});

test("native retained worktree allocates a new branch from the requested base", { timeout: 30_000 }, async () => {
  const repo = join(root, "api-repo");
  mkdirSync(repo);
  const git = (...args: string[]) => execFileSync("git", args, { cwd: repo, encoding: "utf8" }).trim();
  git("init", "-b", "main"); git("config", "user.name", "Integration"); git("config", "user.email", "integration@example.invalid");
  writeFileSync(join(repo, "base.txt"), "APP_API_BASE\n");
  git("add", "."); git("commit", "-m", "Create base");
  const base = git("rev-parse", "HEAD");
  writeFileSync(join(repo, "base.txt"), "APP_API_MAIN\n");
  git("commit", "-am", "Advance main");
  const head = git("rev-parse", "HEAD");
  const surface = createSubagentWorktree("native-retained-api", repo, "native-api-branch", base);
  try {
    assert.equal(execFileSync("git", ["rev-parse", "HEAD"], { cwd: surface.path, encoding: "utf8" }).trim(), base);
    assert.equal(readFileSync(join(surface.path, "base.txt"), "utf8"), "APP_API_BASE\n");
    assert.equal(git("rev-parse", "HEAD"), head);
    assert.equal(git("rev-parse", "refs/heads/native-api-branch"), base);
    assert.ok(listHerdrWorktrees(repo).some(tree => tree.path === surface.path && tree.branch === "native-api-branch"));
    writeFileSync(join(surface.path, "retained.txt"), "APP_API_RETAINED\n");
  } finally { closePane(surface.paneId); }
  assert.equal(readFileSync(join(surface.path, "retained.txt"), "utf8"), "APP_API_RETAINED\n");
  assert.ok(listHerdrWorktrees(repo).some(tree => tree.path === surface.path));
});
