import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { prepareAppCheckoutRemoval, type AppWorktreeMove } from "../pi-extension/subagents/app-cleanup.ts";
import { appWorkspaceRetired } from "../pi-extension/subagents/app-cleanup.ts";

test("a workspace with a remaining non-terminal pane retains its checkout", () => {
  assert.equal(appWorkspaceRetired([{ id: "replica", tabs: [{ id: "tab", terminals: [] }] }], "replica"), false);
  assert.equal(appWorkspaceRetired([{ id: "parent", tabs: [] }], "replica"), true);
});

test("an interrupted checkout move can be resumed without guessing ownership", () => {
  const root = mkdtempSync(join(tmpdir(), "replicate-cleanup-")), repo = join(root, "repo"), checkout = join(root, "checkout"); mkdirSync(repo);
  const git = (...args: string[]) => execFileSync("git", args, { cwd: repo, encoding: "utf8" });
  try {
    git("init", "-q"); git("config", "user.name", "Test"); git("config", "user.email", "test@example.invalid");
    writeFileSync(join(repo, "file"), "content"); git("add", "file"); git("commit", "-qm", "base"); git("worktree", "add", "-b", "replica", checkout);
    let stage: AppWorktreeMove | undefined;
    assert.throws(() => prepareAppCheckoutRemoval(repo, checkout, "replica", undefined, value => { stage = value; throw new Error("interrupted"); }));
    assert.ok(stage && existsSync(join(checkout, "file")));
    assert.equal(prepareAppCheckoutRemoval(repo, checkout, "other", stage, () => {}), undefined);
    assert.ok(existsSync(join(checkout, "file")));
    const path = prepareAppCheckoutRemoval(repo, checkout, "replica", stage, () => { throw new Error("already saved"); });
    assert.equal(path, stage.target); assert.ok(existsSync(join(path!, "file"))); assert.equal(existsSync(checkout), false);
    assert.equal(prepareAppCheckoutRemoval(repo, checkout, "replica", stage, () => {}), path);
    git("worktree", "remove", "--force", path!);
    assert.equal(prepareAppCheckoutRemoval(repo, checkout, "replica", stage, () => {}), null);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
