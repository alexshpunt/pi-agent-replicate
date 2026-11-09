import assert from "node:assert/strict";
import { test } from "node:test";
import { forwardedAppEnvironment, resolveAppCli, type AppBinaryHost } from "../pi-extension/subagents/app-binary.ts";

function host(overrides: Partial<AppBinaryHost> & { files?: string[]; outputs?: Record<string, string> }): AppBinaryHost & { calls: string[] } {
  const calls: string[] = [];
  const files = new Set(overrides.files ?? []);
  return {
    platform: "linux", env: {}, wsl: false, home: () => "/home/user",
    isExecutable: (file) => files.has(file),
    run(command, args) {
      calls.push(`${command} ${args.join(" ")}`);
      const out = overrides.outputs?.[`${command} ${args.join(" ")}`];
      if (out === undefined) throw new Error(`cannot run ${command}`);
      return out;
    },
    ...overrides, calls,
  };
}

const LOCAL = String.raw`C:\Users\someone\AppData\Local`;
const GET_LOCAL = ["-NoProfile", "-NonInteractive", "-Command", '[Environment]::GetFolderPath("LocalApplicationData")'].join(" ");

test("passes the App program and machine settings to a child, keeping an empty machine name", () => {
  assert.deepEqual(forwardedAppEnvironment({}), {});
  assert.deepEqual(forwardedAppEnvironment({ PATH: "/usr/bin", PI_HERDR_APP_CLI: "/pi/app", HERDR_APP_BIN: "/bin/app", PI_HERDR_APP_MACHINE: "" }), { PI_HERDR_APP_CLI: "/pi/app", HERDR_APP_BIN: "/bin/app", PI_HERDR_APP_MACHINE: "" });
});

test("an explicit path wins, then PI_HERDR_APP_CLI, then the app's own HERDR_APP_BIN", () => {
  const files = ["/usr/bin/herdr-app"];
  const env = { PATH: "/usr/bin", PI_HERDR_APP_CLI: "/pi/app", HERDR_APP_BIN: "/bin/app" };
  assert.equal(resolveAppCli("/explicit/app", host({ env, files })), "/explicit/app");
  assert.equal(resolveAppCli(undefined, host({ env, files })), "/pi/app");
  assert.equal(resolveAppCli(undefined, host({ env: { PATH: "/usr/bin", HERDR_APP_BIN: "/bin/app" }, files })), "/bin/app");
});

test("finds herdr-app on PATH and falls back to the plain name when nothing is installed", () => {
  assert.equal(resolveAppCli(undefined, host({ env: { PATH: "/a:/b" }, files: ["/b/herdr-app"] })), "/b/herdr-app");
  const none = host({ env: { PATH: "/a:/b" } });
  assert.equal(resolveAppCli(undefined, none), "herdr-app");
  assert.deepEqual(none.calls, [], "a plain Linux host never starts a helper program");
});

test("WSL accepts the Windows executable on PATH", () => {
  const found = host({ wsl: true, env: { PATH: "/usr/bin:/mnt/c/Tools" }, files: ["/mnt/c/Tools/herdr-app.exe"] });
  assert.equal(resolveAppCli(undefined, found), "/mnt/c/Tools/herdr-app.exe");
});

test("WSL asks Windows where the app is installed and translates the path", () => {
  const exe = "/mnt/c/Users/someone/AppData/Local/Programs/herdr-app/herdr-app.exe";
  const found = host({
    wsl: true, env: { PATH: "/usr/bin:/mnt/c/Windows/System32/WindowsPowerShell/v1.0" },
    files: ["/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe", exe],
    outputs: {
      [`/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe ${GET_LOCAL}`]: `${LOCAL}\r\n`,
      [`wslpath -u ${LOCAL}\\Programs\\herdr-app\\herdr-app.exe`]: `${exe}\n`,
    },
  });
  assert.equal(resolveAppCli(undefined, found), exe);
});

test("WSL without Windows on PATH finds PowerShell through wslpath, wherever Windows is mounted", () => {
  const powershell = "/windows/Windows/System32/WindowsPowerShell/v1.0/powershell.exe";
  const exe = "/windows/Users/someone/AppData/Local/Programs/herdr-app/herdr-app.exe";
  const found = host({
    wsl: true, env: { PATH: "/usr/bin" }, files: [powershell, exe],
    outputs: {
      [`wslpath -u C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe`]: `${powershell}\n`,
      [`${powershell} ${GET_LOCAL}`]: `${LOCAL}\r\n`,
      [`wslpath -u ${LOCAL}\\Programs\\herdr-app\\herdr-app.exe`]: `${exe}\n`,
    },
  });
  assert.equal(resolveAppCli(undefined, found), exe);
});

test("WSL without interop or without the app keeps the plain name", () => {
  assert.equal(resolveAppCli(undefined, host({ wsl: true, env: { PATH: "/usr/bin" } })), "herdr-app");
  const noApp = host({ wsl: true, env: { PATH: "/p" }, files: ["/p/powershell.exe"], outputs: { [`/p/powershell.exe ${GET_LOCAL}`]: `${LOCAL}\r\n`, [`wslpath -u ${LOCAL}\\Programs\\herdr-app\\herdr-app.exe`]: "/missing/herdr-app.exe\n" } });
  assert.equal(resolveAppCli(undefined, noApp), "herdr-app");
});

test("Windows uses PATH, then the per-user install folder", () => {
  const local = String.raw`C:\Users\someone\AppData\Local`;
  const installed = `${local}\\Programs\\herdr-app\\herdr-app.exe`;
  assert.equal(resolveAppCli(undefined, host({ platform: "win32", env: { PATH: String.raw`C:\a;C:\tools`, LOCALAPPDATA: local }, files: [String.raw`C:\tools\herdr-app.exe`] })), String.raw`C:\tools\herdr-app.exe`);
  assert.equal(resolveAppCli(undefined, host({ platform: "win32", env: { PATH: String.raw`C:\a`, LOCALAPPDATA: local }, files: [installed] })), installed);
  assert.equal(resolveAppCli(undefined, host({ platform: "win32", env: { PATH: String.raw`C:\a` }, home: () => String.raw`C:\Users\someone` , files: [installed] })), installed);
  assert.equal(resolveAppCli(undefined, host({ platform: "win32", env: {} })), "herdr-app.exe");
});
