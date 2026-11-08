import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { AppWorktreeCreateError, createAppWorktree, listAppWorktrees } from "../pi-extension/subagents/app-worktree.ts";

test("creates a branch-backed checkout without changing the parent", () => {
  const root = mkdtempSync(join(tmpdir(), "replicate-app-worktree-"));
  try {
    const repo = join(root, "repo"); mkdirSync(repo);
    const git = (...args: string[]) => execFileSync("git", args, { cwd: repo, encoding: "utf8" }).trim();
    git("init", "-q"); git("config", "user.name", "Test"); git("config", "user.email", "test@example.invalid");
    writeFileSync(join(repo, "file"), "committed\n"); git("add", "file"); git("commit", "-qm", "base");
    const base = git("rev-parse", "HEAD"); git("update-ref", "refs/heads/replica/test/job", base, "");
    writeFileSync(join(repo, "file"), "parent edit\n");
    const context = { paneId: "t1", tabId: "b1", workspaceId: "s1", session: "test" };
    const result = createAppWorktree(context, "job", repo, "replica/test/job", base, {
      createWorkspace: (_context, path) => ({ workspaceId: "s2", tabId: "b2", paneId: "t2" }),
      worktreeRoot: join(root, "worktrees"),
    });
    assert.equal(result.branch, "replica/test/job");
    assert.equal(result.workspaceId, "s2");
    assert.equal(execFileSync("git", ["show", "HEAD:file"], { cwd: result.path, encoding: "utf8" }), "committed\n");
    assert.equal(git("status", "--porcelain"), "M file");
    assert.ok(listAppWorktrees(repo).some(item => item.path === result.path && item.branch === result.branch));
    assert.throws(() => createAppWorktree(context, "duplicate", repo, result.branch, base, { worktreeRoot: join(root, "worktrees") }));
    let failedPath = "";
    assert.throws(() => createAppWorktree(context, "lost reply", repo, "replica/test/ambiguous", base, {
      worktreeRoot: join(root, "worktrees"),
      createWorkspace: (_context, path) => { failedPath = path; throw new Error("connection lost"); },
    }), error => error instanceof AppWorktreeCreateError && error.worktree.path === failedPath && error.worktree.workspaceId === undefined);
    assert.ok(existsSync(failedPath));
    assert.ok(listAppWorktrees(repo).some(item => item.path === failedPath && item.branch === "replica/test/ambiguous"));
  } finally { rmSync(root, { recursive: true, force: true }); }
});
