import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { listAppWorktrees } from "./app-worktree.ts";
import type { AppSpace } from "./app-operations.ts";

/** A surviving workspace can contain mod panes omitted from the terminal list. */
export function appWorkspaceRetired(spaces: AppSpace[], workspaceId: string): boolean {
  return !spaces.some(space => space.id === workspaceId);
}

/** Written before Git moves the checkout; identifies its original directory incarnation. */
export interface AppWorktreeMove { original: string; target: string; device: string; inode: string }
function samePath(a: string, b: string): boolean {
  const left = resolve(a), right = resolve(b);
  return process.platform === "win32" ? left.toLowerCase() === right.toLowerCase() : left === right;
}
function incarnation(path: string): { device: string; inode: string } {
  const stat = statSync(path, { bigint: true });
  return { device: String(stat.dev), inode: String(stat.ino) };
}

/**
 * Move a checkout to a unique sibling before deleting it. On Windows the move
 * fails without modifying files if any process has its cwd inside the tree.
 * null means an already-completed removal; undefined means ownership is unclear.
 */
export function prepareAppCheckoutRemoval(cwd: string, original: string, branch: string, saved: AppWorktreeMove | undefined, save: (move: AppWorktreeMove) => void): string | null | undefined {
  const matches = () => listAppWorktrees(cwd).filter(item => item.isLinkedWorktree && item.branch === branch);
  let entries = matches();
  if (entries.length > 1) throw new Error("Ambiguous replica worktree ownership.");
  if (!saved) {
    if (entries.length !== 1 || !samePath(entries[0].path, original) || !existsSync(original)) return undefined;
    saved = { original, target: `${original}.replicate-cleanup-${randomUUID()}`, ...incarnation(original) };
    save(saved);
  }
  if (!saved.original || !samePath(saved.original, original)) return undefined;
  const prefix = `${resolve(original)}.replicate-cleanup-`;
  if (!resolve(saved.target).startsWith(prefix) || !/^[0-9a-f-]{36}$/.test(resolve(saved.target).slice(prefix.length)) || typeof saved.device !== "string" || typeof saved.inode !== "string") return undefined;
  const sourceExists = existsSync(original), targetExists = existsSync(saved.target);
  if (!sourceExists && !targetExists) return entries.length === 0 ? null : undefined;
  if (sourceExists === targetExists) return undefined;
  const present = sourceExists ? original : saved.target;
  const actual = incarnation(present);
  if (actual.device !== saved.device || actual.inode !== saved.inode) return undefined;
  if (sourceExists) {
    if (entries.length !== 1 || !samePath(entries[0].path, original)) return undefined;
    execFileSync("git", ["worktree", "move", original, saved.target], { cwd, encoding: "utf8", stdio: "pipe", timeout: 60_000 });
  } else if (entries.length === 1 && samePath(entries[0].path, original)) {
    // The filesystem rename may have completed before Git wrote its metadata.
    execFileSync("git", ["worktree", "repair", saved.target], { cwd, encoding: "utf8", stdio: "pipe", timeout: 60_000 });
  }
  entries = matches();
  const moved = existsSync(saved.target) && incarnation(saved.target);
  if (entries.length !== 1 || !samePath(entries[0].path, saved.target) || !moved || moved.device !== saved.device || moved.inode !== saved.inode) return undefined;
  return saved.target;
}
