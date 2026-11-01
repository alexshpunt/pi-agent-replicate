import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it } from "node:test";
import { readReplicaDirectoryMode, registerReplicaDirectoryCommand } from "../pi-extension/subagents/replica-directory-settings.ts";

it("persists a directory mode per project and defaults to worktree", async () => {
  const root = mkdtempSync(join(tmpdir(), "replica-settings-"));
  const a = join(root, "a"), b = join(root, "b");
  mkdirSync(a); mkdirSync(b);
  let command: any;
  registerReplicaDirectoryCommand({ registerCommand: (_name: string, value: unknown) => { command = value; } } as any);
  const ctx = (cwd: string) => ({ cwd, hasUI: true, ui: { notify() {}, select: async () => undefined } });
  try {
    assert.equal(readReplicaDirectoryMode(a), "worktree");
    await command.handler("shared", ctx(a));
    assert.equal(readReplicaDirectoryMode(a), "shared");
    assert.equal(readReplicaDirectoryMode(b), "worktree");
    await command.handler("worktree", ctx(a));
    assert.equal(readReplicaDirectoryMode(a), "worktree");
    await command.handler("invalid", ctx(a));
    assert.equal(readReplicaDirectoryMode(a), "worktree");
    writeFileSync(join(a, ".pi", "replicate.json"), "invalid json");
    assert.throws(() => readReplicaDirectoryMode(a));
  } finally { rmSync(root, { recursive: true, force: true }); }
});
