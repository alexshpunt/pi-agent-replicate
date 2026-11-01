import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it } from "node:test";
import { createSharedReplicaWork, readReplicaWork, checkpointReplicaCompletion, joinReplicaWork } from "../pi-extension/subagents/replica-work.ts";

for (const failed of [false, true]) it(`settles ${failed ? "failed" : "successful"} shared work without touching files or requiring Git`, () => {
 const root = mkdtempSync(join(tmpdir(), "replica-shared-"));
 try {
  const project = join(root, "project"), file = join(root, "store", "work.json"), session = join(root, "session.jsonl");
  mkdirSync(project); writeFileSync(join(project, "shared"), "existing changes"); writeFileSync(session, "session\n");
  createSharedReplicaWork(file, "id", "parent", project);
  assert.equal(readReplicaWork(file).mode, "shared");
  const result = checkpointReplicaCompletion(file, project, session, { name: "test", task: "task", summary: failed ? "" : "done", exitCode: failed ? 1 : 0, elapsed: 1 });
  assert.equal(result.integration.status, failed ? "not-attempted" : "shared");
  assert.equal(result.checkpoint, undefined);
  assert.equal(joinReplicaWork(file, project).integration.status, result.integration.status);
  assert.equal(readFileSync(join(project, "shared"), "utf8"), "existing changes");
 } finally { rmSync(root, { recursive: true, force: true }); }
});
