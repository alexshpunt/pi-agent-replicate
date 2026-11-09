import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { getAppContext } from "../pi-extension/subagents/app-context.ts";

test("validates the current App terminal on its own core connection", { skip: process.platform === "win32" }, () => {
  const dir = mkdtempSync(join(tmpdir(), "replicate-app-context-"));
  try {
    const hc = join(dir, "hc");
    writeFileSync(hc, `#!/bin/sh\n[ "$1" = get ] && [ "$2" = t7 ] && [ "$HC_SESSION" = private ] && printf '%s\\n' '{"address":"t7","state":"live","labels":{"herdr.space":"s2","herdr.tab":"b3"}}'\n`);
    chmodSync(hc, 0o755);
    const env = { ...process.env, PI_TELEPORT_APP_CONTEXT: undefined, HC_TERMINAL_ID: "t7", HC_SESSION: "private", HC_SOCKET: "/tmp/core", HC_TERMINAL_SOCKET: "/tmp/core", PATH: `${dir}:${process.env.PATH}` };
    const context = getAppContext(env)!;
    assert.equal(context.paneId, "t7");
    assert.equal(context.workspaceId, "s2");
    assert.equal(context.tabId, "b3");
    assert.equal(context.session, "private");
    const routeFile = join(dir, "route.json");
    writeFileSync(routeFile, JSON.stringify({ backend: "app", session: "private", appMachine: "test-machine", appSsh: { target: "test-host" } }));
    assert.equal(getAppContext({ ...env, PI_TELEPORT_APP_CONTEXT: routeFile })?.appSsh?.target, "test-host");
    writeFileSync(routeFile, JSON.stringify({ backend: "app", session: "other", appMachine: "test-machine", appSsh: { target: "test-host" } }));
    assert.throws(() => getAppContext({ ...env, PI_TELEPORT_APP_CONTEXT: routeFile }));
    assert.equal(context.appMachine, undefined, "the machine is learned from the App's listing, not guessed");
    assert.equal(getAppContext({ ...env, PI_HERDR_APP_MACHINE: " laptop " })?.appMachine, "laptop");
    assert.equal(getAppContext({ ...env, PI_HERDR_APP_MACHINE: "" })?.appMachine, "");
    assert.throws(() => getAppContext({ ...env, PI_HERDR_APP_MACHINE: "laptop/t7" }));
    assert.throws(() => getAppContext({ ...env, HC_TERMINAL_SOCKET: "/tmp/wrong" }));
    assert.throws(() => getAppContext({ ...env, HC_TERMINAL_ID: "not-owned" }));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
