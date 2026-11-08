import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { windowsLaunchScript, windowsScriptInvocation } from "../pi-extension/subagents/windows-launch.ts";

test("launches with exact paths, arguments and environment in native Windows PowerShell", { skip: process.platform !== "win32" }, () => {
  const root = mkdtempSync(join(tmpdir(), "реплика test's "));
  try {
    const child = join(root, "child.js"), script = join(root, "launch.ps1");
    writeFileSync(child, "console.log(JSON.stringify({cwd:process.cwd(),args:process.argv.slice(2),value:process.env.PI_TEST_VALUE}))");
    const args = ["space and 'quote'", "a&b", 'a"quoted value"b', "", "ends\\", 'before\\"quoted"'];
    writeFileSync(script, "\uFEFF" + windowsLaunchScript({ cwd: root, executable: process.execPath, args: [child, ...args], env: { PI_TEST_VALUE: "this 'value' & that" } }));
    const output = execFileSync("powershell.exe", ["-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", script], { encoding: "utf8" });
    const result = JSON.parse(output.split(/\r?\n/)[0]);
    assert.deepEqual(result, { cwd: root, args, value: "this 'value' & that" });
    assert.match(windowsScriptInvocation(script), /^powershell\.exe .* -EncodedCommand [A-Za-z0-9+/=]+$/);
    const viaCmd = execFileSync("cmd.exe", ["/d", "/s", "/c", windowsScriptInvocation(script)], { encoding: "utf8" });
    assert.deepEqual(JSON.parse(viaCmd.split(/\r?\n/)[0]), { cwd: root, args, value: "this 'value' & that" });
    const piCmd = execFileSync("where.exe", ["pi.cmd"], { encoding: "utf8" }).trim().split(/\r?\n/)[0];
    const piCli = join(dirname(piCmd), "node_modules", "@earendil-works", "pi-coding-agent", "dist", "bundle", "cli.js");
    writeFileSync(script, "\uFEFF" + windowsLaunchScript({ cwd: root, executable: process.execPath, args: [piCli, "--version"], env: {} }));
    const pi = execFileSync("powershell.exe", ["-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", script], { encoding: "utf8" });
    assert.match(pi, /__SUBAGENT_DONE_0__/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
