import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

test("Windows refuses to move an occupied worktree without deleting its files", { skip: process.platform !== "win32" }, async () => {
  const root = mkdtempSync(join(tmpdir(), "replicate-move-")), repo = join(root, "repo"), checkout = join(root, "checkout"), moved = join(root, "moved");
  mkdirSync(repo);
  const git = (...args: string[]) => spawnSync("git", args, { cwd: repo, encoding: "utf8" });
  let child: ReturnType<typeof spawn> | undefined;
  try {
    for (const args of [["init", "-q"], ["config", "user.name", "Test"], ["config", "user.email", "test@example.invalid"]]) assert.equal(git(...args).status, 0);
    writeFileSync(join(repo, "file"), "retained\n");
    for (const args of [["add", "file"], ["commit", "-qm", "base"], ["worktree", "add", "-b", "replica", checkout]]) assert.equal(git(...args).status, 0);
    const subdir = join(checkout, "subdir"); mkdirSync(subdir);
    child = spawn("cmd.exe", ["/d", "/k"], { cwd: subdir, stdio: "pipe", windowsHide: true });
    await new Promise<void>((resolve, reject) => { child!.once("spawn", resolve); child!.once("error", reject); });
    assert.notEqual(git("worktree", "move", checkout, moved).status, 0);
    assert.ok(existsSync(join(checkout, "file")));
    child.kill(); await new Promise(resolve => child!.once("exit", resolve)); child = undefined;
    assert.equal(git("worktree", "move", checkout, moved).status, 0);
    assert.ok(existsSync(join(moved, "file")));
    assert.equal(git("worktree", "remove", "--force", moved).status, 0);
  } finally {
    if (child) { child.kill(); await new Promise(resolve => child!.once("exit", resolve)); }
    rmSync(root, { recursive: true, force: true });
  }
});
