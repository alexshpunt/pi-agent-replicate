import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, it } from "node:test";
import { readReplicaDirectoryMode, registerReplicaDirectoryCommand, resolveReplicaDirectoryMode } from "../pi-extension/subagents/replica-directory-settings.ts";

let root: string, agentDir: string, previousAgentDir: string | undefined;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "replica-settings-"));
  agentDir = join(root, "agent");
  previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = agentDir;
});
afterEach(() => {
  if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
  rmSync(root, { recursive: true, force: true });
});

function setup() {
  const a = join(root, "a"), b = join(root, "b");
  mkdirSync(a); mkdirSync(b);
  let command: any;
  registerReplicaDirectoryCommand({ registerCommand: (_name: string, value: unknown) => { command = value; } } as any);
  const notes: string[] = [];
  const ctx = (cwd: string, select: (title: string, options: string[]) => Promise<string | undefined> = async () => undefined) =>
    ({ cwd, hasUI: true, ui: { notify(message: string) { notes.push(message); }, select } });
  return { a, b, command, ctx, notes };
}

it("persists a directory mode per project and defaults to the shared directory", async () => {
  const { a, b, command, ctx } = setup();
  assert.deepEqual(resolveReplicaDirectoryMode(a), { mode: "shared", source: "default" });
  await command.handler("worktree", ctx(a));
  assert.deepEqual(resolveReplicaDirectoryMode(a), { mode: "worktree", source: "project" });
  assert.equal(readReplicaDirectoryMode(b), "shared");
  await command.handler("shared", ctx(a));
  assert.deepEqual(resolveReplicaDirectoryMode(a), { mode: "shared", source: "project" });
  await command.handler("invalid", ctx(a));
  assert.equal(readReplicaDirectoryMode(a), "shared");
  writeFileSync(join(a, ".pi", "replicate.json"), "invalid json");
  assert.throws(() => readReplicaDirectoryMode(a));
});

it("applies a global mode to projects without their own setting", async () => {
  const { a, b, command, ctx, notes } = setup();
  await command.handler("shared", ctx(a));
  await command.handler("--global worktree", ctx(b));
  assert.equal(JSON.parse(readFileSync(join(agentDir, "replicate.json"), "utf8")).directoryMode, "worktree");
  assert.deepEqual(resolveReplicaDirectoryMode(b), { mode: "worktree", source: "global" });
  assert.deepEqual(resolveReplicaDirectoryMode(a), { mode: "shared", source: "project" });
  await command.handler("--global worktree", ctx(a));
  assert.match(notes.at(-1)!, /this project overrides it/);
  await command.handler("shared --global extra", ctx(a));
  assert.match(notes.at(-1)!, /--global/);
  writeFileSync(join(agentDir, "replicate.json"), "{}");
  assert.throws(() => readReplicaDirectoryMode(b), /Invalid replica directory mode/);
});

it("offers project and global choices interactively", async () => {
  const { a, b, command, ctx } = setup();
  let offered: string[] = [];
  await command.handler("", ctx(a, async (_title, options) => { offered = options; return "shared (all projects)"; }));
  assert.deepEqual(offered, ["worktree (this project)", "shared (this project)", "worktree (all projects)", "shared (all projects)"]);
  assert.deepEqual(resolveReplicaDirectoryMode(b), { mode: "shared", source: "global" });
  await command.handler("--global", ctx(a, async (_title, options) => { offered = options; return "worktree (all projects)"; }));
  assert.deepEqual(offered, ["worktree (all projects)", "shared (all projects)"]);
  assert.equal(readReplicaDirectoryMode(b), "worktree");
});
