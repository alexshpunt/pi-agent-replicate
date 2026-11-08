import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { createAppWorkspace } from "./app-operations.js";
/** A checkout exists even though its App workspace could not be established. */
export class AppWorktreeCreateError extends Error {
    worktree;
    constructor(message, worktree) { super(message); this.name = "AppWorktreeCreateError"; this.worktree = worktree; }
}
/** Use Git's NUL-delimited machine format: paths may contain spaces or newlines. */
export function listAppWorktrees(cwd) {
    const output = execFileSync("git", ["worktree", "list", "--porcelain", "-z"], { cwd, encoding: "utf8", timeout: 15_000 });
    return output.split("\0\0").map((record, index) => {
        const fields = record.split("\0"), path = fields.find(field => field.startsWith("worktree "))?.slice(9);
        const ref = fields.find(field => field.startsWith("branch refs/heads/"))?.slice(18);
        return path && ref ? { path: resolve(path), branch: ref, isLinkedWorktree: index !== 0 } : undefined;
    }).filter((entry) => !!entry);
}
function samePath(a, b) {
    const left = resolve(a), right = resolve(b);
    return process.platform === "win32" ? left.toLowerCase() === right.toLowerCase() : left === right;
}
export function createAppWorktree(context, name, cwd, branch, base, options = {}) {
    const git = (args) => execFileSync("git", args, { cwd, encoding: "utf8", timeout: 60_000 }).replace(/\r?\n$/, "");
    const repo = git(["rev-parse", "--show-toplevel"]);
    const expected = git(["rev-parse", "--verify", `${base}^{commit}`]);
    git(["check-ref-format", "--branch", branch]);
    const existing = spawnSync("git", ["rev-parse", "--verify", `refs/heads/${branch}^{commit}`], { cwd, encoding: "utf8", timeout: 15_000 });
    if (existing.error)
        throw existing.error;
    if (existing.status !== 0 && existing.status !== 128)
        throw new Error(`Cannot inspect the requested branch: ${existing.stderr}`);
    if (existing.status === 0 && existing.stdout.trim() !== expected)
        throw new Error("The requested branch does not point to the supplied base.");
    if (listAppWorktrees(cwd).some(item => item.branch === branch))
        throw new Error("The requested branch is already checked out.");
    const root = options.worktreeRoot ?? join(dirname(repo), `${basename(repo)}-worktrees`);
    mkdirSync(root, { recursive: true });
    const slug = branch.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 80) || "replica";
    const path = mkdtempSync(join(root, `${slug}-`));
    try {
        git(existing.status === 0 ? ["worktree", "add", path, branch] : ["worktree", "add", "-b", branch, path, expected]);
    }
    catch (error) {
        const matches = listAppWorktrees(cwd).filter(item => item.branch === branch && samePath(item.path, path));
        if (matches.length === 1)
            throw new AppWorktreeCreateError(String(error), matches[0]);
        throw error;
    }
    const worktree = { path, branch, isLinkedWorktree: true };
    try {
        const location = (options.createWorkspace ?? createAppWorkspace)(context, path, name);
        return { ...worktree, ...location };
    }
    catch (error) {
        // A lost App reply cannot prove ownership of any visible workspace. Keep the
        // checkout and any possibly created UI for manual recovery; never guess.
        throw new AppWorktreeCreateError(String(error), worktree);
    }
}
