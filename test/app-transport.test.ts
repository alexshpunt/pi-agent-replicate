import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createServer } from "node:net";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { resolve } from "node:path";
import { AppCliNotFoundError, runApp, UnknownAppOutcome } from "../pi-extension/subagents/app-transport.ts";

test("routes App commands to the captured local core, not the caller's terminal", { skip: process.platform === "win32" }, () => {
  const dir = mkdtempSync(join(tmpdir(), "replicate-app-transport-"));
  try {
    const cli = join(dir, "app");
    writeFileSync(cli, `#!/bin/sh\nprintf '{"session":"%s","socket":"%s","terminal":"%s","scope":"%s","argument":"%s"}\n' "$HC_SESSION" "$HC_SOCKET" "$HC_TERMINAL_ID" "$HC_SCOPE" "$1"\n`);
    chmodSync(cli, 0o755);
    const result = runApp({ paneId: "t7", tabId: "b1", workspaceId: "s1", session: "owned", coreSocketPath: "/owned.sock", appCli: cli }, ["ls"]);
    assert.deepEqual(result, { session: "owned", socket: "/owned.sock", terminal: "t7", scope: "", argument: "ls" });
  } finally { rmSync(dir, { recursive: true, force: true }); }
});


test("reports a missing App program as a definite failure that names the fix", () => {
  const dir = mkdtempSync(join(tmpdir(), "replicate-app-missing-"));
  try {
    const missing = join(dir, "no-such-app");
    const context = { paneId: "t7", tabId: "b1", workspaceId: "s1", session: "owned", appMachine: "", appCli: missing };
    assert.throws(() => runApp(context, ["ls"]), (error: Error) => error instanceof AppCliNotFoundError && !(error instanceof UnknownAppOutcome) && error.message.includes(missing) && error.message.includes("PI_HERDR_APP_CLI"));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("finds the App program through HERDR_APP_BIN when the context names none", { skip: process.platform === "win32" }, () => {
  const dir = mkdtempSync(join(tmpdir(), "replicate-app-bin-"));
  const saved = { cli: process.env.PI_HERDR_APP_CLI, bin: process.env.HERDR_APP_BIN };
  try {
    const cli = join(dir, "app");
    writeFileSync(cli, `#!/bin/sh\nprintf '{"argument":"%s"}\\n' "$1"\n`); chmodSync(cli, 0o755);
    delete process.env.PI_HERDR_APP_CLI; process.env.HERDR_APP_BIN = cli;
    assert.deepEqual(runApp({ paneId: "t7", tabId: "b1", workspaceId: "s1", session: "owned" }, ["ls"]), { argument: "ls" });
  } finally {
    for (const [key, value] of [["PI_HERDR_APP_CLI", saved.cli], ["HERDR_APP_BIN", saved.bin]] as const) if (value === undefined) delete process.env[key]; else process.env[key] = value;
    rmSync(dir, { recursive: true, force: true });
  }
});

test("routes App commands through the saved SSH desktop connection", { skip: process.platform === "win32" }, () => {
  const dir = mkdtempSync(join(tmpdir(), "replicate-app-ssh-"));
  const path = process.env.PATH;
  try {
    const cli = join(dir, "app"), ssh = join(dir, "ssh");
    writeFileSync(cli, `#!/bin/sh\nprintf '{"session":"%s","socket":"%s","terminal":"%s","argument":"%s"}\n' "$HC_SESSION" "$HC_SOCKET" "$HC_TERMINAL_ID" "$1"\n`);
    writeFileSync(ssh, `#!/bin/sh\nfor last do :; done\nexec sh -c "$last"\n`);
    chmodSync(cli, 0o755); chmodSync(ssh, 0o755);
    process.env.PATH = `${dir}:${path}`;
    const result = runApp({ paneId: "t7", tabId: "b1", workspaceId: "s1", session: "remote", appSsh: { target: "trusted-host", session: "desktop", coreSocketPath: "/desktop.sock", appCli: cli } }, ["ls"]);
    assert.deepEqual(result, { session: "desktop", socket: "/desktop.sock", terminal: "", argument: "ls" });
  } finally { process.env.PATH = path; rmSync(dir, { recursive: true, force: true }); }
});


test("routes App requests through the authenticated Teleport controller", { skip: process.platform === "win32" }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "replicate-app-controller-"));
  const socket = join(dir, "controller.sock");
  let received: unknown;
  const server = createServer((connection) => {
    let input = "";
    connection.on("data", (chunk) => {
      input += chunk;
      if (!input.includes("\n")) return;
      received = JSON.parse(input);
      connection.end(JSON.stringify({ ok: true, result: { spaces: [{ id: "owned" }] } }) + "\n");
    });
  });
  try {
    await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(socket, resolve); });
    const module = resolve("pi-extension/subagents/app-transport.ts");
    const context = { paneId: "t7", tabId: "b1", workspaceId: "s1", session: "owned", appRoute: { socket, token: "test-token", operationId: "op" } };
    const code = `import {runApp} from ${JSON.stringify(module)}; console.log(JSON.stringify(runApp(${JSON.stringify(context)}, ["ls"])));`;
    const result = await promisify(execFile)(process.execPath, ["--experimental-strip-types", "--input-type=module", "-e", code]);
    assert.deepEqual(JSON.parse(result.stdout), { spaces: [{ id: "owned" }] });
    assert.deepEqual(received, { action: "app", args: ["ls"], token: "test-token" });
  } finally { await new Promise<void>((resolve) => server.close(() => resolve())); rmSync(dir, { recursive: true, force: true }); }
});


test("does not treat a lost controller receipt as a safe failure", { skip: process.platform === "win32" }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "replicate-app-disconnect-"));
  const socket = join(dir, "controller.sock");
  const server = createServer((connection) => connection.once("data", () => connection.destroy()));
  try {
    await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(socket, resolve); });
    const module = resolve("pi-extension/subagents/app-transport.ts");
    const context = { paneId: "t7", tabId: "b1", workspaceId: "s1", session: "owned", appRoute: { socket, token: "test-token", operationId: "op" } };
    const code = `import {runApp,UnknownAppOutcome} from ${JSON.stringify(module)}; try {runApp(${JSON.stringify(context)}, ["do","tab.new","{}"])} catch(e) {console.log(JSON.stringify(e instanceof UnknownAppOutcome))}`;
    const result = await promisify(execFile)(process.execPath, ["--experimental-strip-types", "--input-type=module", "-e", code]);
    assert.equal(JSON.parse(result.stdout), true);
  } finally { await new Promise<void>((resolve) => server.close(() => resolve())); rmSync(dir, { recursive: true, force: true }); }
});