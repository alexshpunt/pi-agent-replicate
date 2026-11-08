import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { runAppCore } from "../pi-extension/subagents/app-core.ts";
import { appProcessInfo } from "../pi-extension/subagents/app-core.ts";
import { inspectAppTerminal, readAppTerminal, sendAppCommand, sendAppEscape } from "../pi-extension/subagents/app-core.ts";
import { appProcessInfoAsync } from "../pi-extension/subagents/app-core.ts";

test("addresses the captured core connection and clears inherited lifetime scopes", { skip: process.platform === "win32" }, () => {
  const dir = mkdtempSync(join(tmpdir(), "replicate-app-core-")), path = process.env.PATH, scope = process.env.HC_SCOPE;
  try {
    const cli = join(dir, "hc");
    writeFileSync(cli, `#!/bin/sh\nprintf '{"session":"%s","socket":"%s","terminal":"%s","scope":"%s","target":"%s"}\\n' "$HC_SESSION" "$HC_SOCKET" "$HC_TERMINAL_ID" "$HC_SCOPE" "$2"\n`); chmodSync(cli, 0o755);
    process.env.PATH = `${dir}:${path}`;
    process.env.HC_SCOPE = "parent-lifetime";
    const result = JSON.parse(runAppCore({ paneId: "t7", tabId: "b1", workspaceId: "s1", session: "owned", coreSocketPath: "/owned.sock" }, ["get", "t9"]));
    assert.deepEqual(result, { session: "owned", socket: "/owned.sock", terminal: "t7", scope: "", target: "t9" });
  } finally { if (scope === undefined) delete process.env.HC_SCOPE; else process.env.HC_SCOPE = scope; if (path === undefined) delete process.env.PATH; else process.env.PATH = path; rmSync(dir, { recursive: true, force: true }); }
});


test("observes a live terminal's process and rejects a mismatched terminal", { skip: process.platform !== "linux" }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "replicate-app-process-")), path = process.env.PATH;
  try {
    const cli = join(dir, "hc");
    writeFileSync(cli, `#!/bin/sh\nprintf '%s\\n' '{"address":"t9","state":"live","pid":${process.pid}}'\n`); chmodSync(cli, 0o755);
    process.env.PATH = `${dir}:${path}`;
    const context = { paneId: "t7", tabId: "b1", workspaceId: "s1", session: "owned" };
    assert.equal(appProcessInfo(context, "t9").shellPid, process.pid);
    assert.equal((await appProcessInfoAsync(context, "t9")).shellPid, process.pid);
    await assert.rejects(appProcessInfoAsync(context, "t10"));
    assert.throws(() => appProcessInfo(context, "t10"));
  } finally { if (path === undefined) delete process.env.PATH; else process.env.PATH = path; rmSync(dir, { recursive: true, force: true }); }
});

test("process observation works when the parent Node process uses input-type", { skip: process.platform !== "linux" }, () => {
  const dir = mkdtempSync(join(tmpdir(), "replicate-app-worker-"));
  try {
    const cli = join(dir, "hc");
    writeFileSync(cli, `#!/bin/sh\nprintf '%s\\n' '{"address":"t9","state":"live","pid":${process.pid}}'\n`); chmodSync(cli, 0o755);
    const source = `import {appProcessInfoAsync} from ${JSON.stringify(new URL("../pi-extension/subagents/app-core.ts", import.meta.url).href)}; const info = await appProcessInfoAsync({paneId:'t7',tabId:'b1',workspaceId:'s1',session:'owned'},'t9'); console.log(info.shellPid);`;
    const output = execFileSync(process.execPath, ["--experimental-strip-types", "--input-type=module", "-e", source], { encoding: "utf8", env: { ...process.env, FORCE_COLOR: "0", PATH: `${dir}:${process.env.PATH}` } }).trim();
    assert.equal(Number(output), process.pid, JSON.stringify(output));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
test("reads, inspects and addresses only the requested terminal", { skip: process.platform === "win32" }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "replicate-app-io-")), path = process.env.PATH;
  try {
    const cli = join(dir, "hc"), log = join(dir, "commands");
    writeFileSync(cli, `#!/bin/sh\nprintf '%s\\n' "$*" >> "${log}"\ncase "$1" in\nget) if [ "$2" = t-missing ]; then printf '%s\\n' '{"error":{"kind":"not_found"}}' >&2; exit 3; fi; if [ "$2" = t-down ]; then exit 1; fi; printf '%s\\n' '{"address":"t9","state":"live","agent":"pi","status":"working"}' ;;\nread) printf '%s\\n' 'terminal output' ;;\nesac\n`); chmodSync(cli, 0o755);
    process.env.PATH = `${dir}:${path}`;
    const context = { paneId: "t7", tabId: "b1", workspaceId: "s1", session: "owned" };
    assert.deepEqual(await inspectAppTerminal(context, "t9"), { kind: "present", agent: "pi", agentStatus: "working" });
    assert.equal((await inspectAppTerminal(context, "t-missing")).kind, "missing");
    assert.equal((await inspectAppTerminal(context, "t-down")).kind, "unavailable");
    assert.equal(await readAppTerminal(context, "t9", 50), "terminal output\n");
    sendAppCommand(context, "t9", "echo hello");
    sendAppEscape(context, "t9");
    const { readFileSync } = await import("node:fs");
    assert.deepEqual(readFileSync(log, "utf8").trim().split("\n"), ["get t9", "get t-missing", "get t-down", "read --lines 50 t9", "send t9 echo hello", "keys t9 esc"]);
  } finally { if (path === undefined) delete process.env.PATH; else process.env.PATH = path; rmSync(dir, { recursive: true, force: true }); }
});