import { strict as assert } from "node:assert";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { inspectHerdrPane, readHerdrScreen, sendHerdrCommand } from "../pi-extension/subagents/herdr.ts";

test("routes addressed terminal operations through its App core", { skip: process.platform === "win32" }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "replicate-app-routing-"));
  const saved = { ...process.env };
  try {
    const hc = join(dir, "hc");
    writeFileSync(hc, `#!/bin/sh\ncase "$1:$2" in\nget:t7) printf '%s\\n' '{"address":"t7","state":"live","labels":{"herdr.space":"s1","herdr.tab":"b1"}}' ;;\nget:t9) printf '%s\\n' '{"address":"t9","state":"live","status":"working"}' ;;\nread:*) printf '%s\\n' 'real output' ;;\nsend:t9) printf '%s\\n' "$3" > "${dir}/sent" ;;\n*) exit 1 ;;\nesac\n`); chmodSync(hc, 0o755);
    process.env.PATH = `${dir}:${saved.PATH}`; process.env.HC_TERMINAL_ID = "t7";
    delete process.env.HERDR_ENV; delete process.env.PI_TELEPORT_APP_CONTEXT; delete process.env.HC_SOCKET; delete process.env.HC_TERMINAL_SOCKET;
    assert.deepEqual(await inspectHerdrPane("t9"), { kind: "present", agentStatus: "working" });
    assert.equal(readHerdrScreen("t9", 10), "real output\n");
    sendHerdrCommand("t9", "echo child");
    const { readFileSync } = await import("node:fs");
    assert.equal(readFileSync(join(dir, "sent"), "utf8"), "echo child\n");
  } finally { process.env = saved; rmSync(dir, { recursive: true, force: true }); }
});
