import { strict as assert } from "node:assert";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { seedSessionBinding, writeBindingFile } from "../pi-extension/subagents/session-binding.ts";
import { materializeResultFile } from "../pi-extension/subagents/delivery-files.ts";

test("session ownership can be durably published on the host filesystem", () => {
  const dir = mkdtempSync(join(tmpdir(), "replicate-durable-"));
  try {
    const file = join(dir, "binding.json");
    writeBindingFile(file, { sessionId: "owned-session" });
    assert.deepEqual(JSON.parse(readFileSync(file, "utf8")), { sessionId: "owned-session" });
    const session = join(dir, "session.jsonl");
    writeFileSync(session, JSON.stringify({ type: "session", id: "owned-session" }) + "\n");
    const binding = seedSessionBinding(session, { version: 1, storeDir: dir });
    assert.equal(binding.sessionId, "owned-session");
    const input = { sessionsDir: dir, childSessionId: "child", deliveryId: "delivery", status: "completed" as const, agentName: "replica", now: 0, answer: "result" };
    const result = materializeResultFile(input);
    assert.equal(materializeResultFile(input).path, result.path);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
