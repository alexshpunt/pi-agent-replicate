import { execFileSync } from "node:child_process";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { Worker } from "node:worker_threads";
import { readFileSync, readdirSync, readlinkSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { AppContext } from "./app-context.ts";

/** Capture the core identity without inheriting the parent's process lifetime scope. */
export function appCoreEnvironment(context: AppContext): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, HC_SESSION: context.session, HC_TERMINAL_ID: context.paneId };
  for (const [key, value] of Object.entries({
    HC_SOCKET: context.coreSocketPath, HC_TERMINAL_SOCKET: context.coreSocketPath, HC_SCOPE: undefined,
    XDG_STATE_HOME: context.stateHome, XDG_CONFIG_HOME: context.configHome,
    XDG_RUNTIME_DIR: context.runtimeDir, HERDR_APP_HOME: context.appHome,
  })) {
    if (value === undefined) delete env[key]; else env[key] = value;
  }
  return env;
}

/** Run a native core command against the captured terminal's own core. */
export function runAppCore(context: AppContext, args: string[]): string {
  return execFileSync("hc", args, { encoding: "utf8", env: appCoreEnvironment(context), timeout: 15_000, maxBuffer: 16 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
}


export interface AppProcessInfo {
  paneId: string;
  shellPid: number;
  shellOwnsForeground: boolean;
  foregroundProcessGroupId?: number;
  foregroundProcesses: Array<{ pid: number; cwd: string; argv: string[] }>;
}

const execFileAsync = promisify(execFile);

async function runAppCoreAsync(context: AppContext, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("hc", args, { encoding: "utf8", env: appCoreEnvironment(context), timeout: 15_000, maxBuffer: 16 * 1024 * 1024, windowsHide: true });
  return stdout;
}

export async function inspectAppTerminal(context: AppContext, paneId: string): Promise<{ kind: "present"; agent?: string; agentStatus: "idle" | "working" | "blocked" | "done" | "unknown" } | { kind: "missing"; error?: string } | { kind: "unavailable"; error: string }> {
  try {
    const terminal = JSON.parse(await runAppCoreAsync(context, ["get", paneId]));
    if (terminal.address !== paneId || !["live", "finished"].includes(terminal.state)) throw new Error("Invalid terminal observation.");
    const status = ["idle", "working", "blocked", "done"].includes(terminal.status) ? terminal.status : "unknown";
    return { kind: "present", ...(typeof terminal.agent === "string" ? { agent: terminal.agent } : {}), agentStatus: status };
  } catch (error: any) {
    for (const raw of [error?.stdout, error?.stderr]) {
      if (typeof raw !== "string") continue;
      try { if (JSON.parse(raw)?.error?.kind === "not_found") return { kind: "missing" }; } catch { /* not a structured response */ }
    }
    return { kind: "unavailable", error: error instanceof Error ? error.message : String(error) };
  }
}

export function readAppTerminal(context: AppContext, paneId: string, lines: number): Promise<string> {
  return runAppCoreAsync(context, ["read", "--lines", String(lines), paneId]);
}
export function sendAppCommand(context: AppContext, paneId: string, command: string): void {
  runAppCore(context, ["send", paneId, command]);
}
export function sendAppEscape(context: AppContext, paneId: string): void {
  runAppCore(context, ["keys", paneId, "esc"]);
}
/** Native process inspection can take seconds; never run it on Pi's event loop. */
export function appProcessInfoAsync(context: AppContext, paneId: string): Promise<AppProcessInfo> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL("./app-observer-worker.js", import.meta.url), { workerData: { context, paneId }, execArgv: [] });
    let replied = false;
    worker.once("message", (message: { result?: AppProcessInfo; error?: string }) => {
      replied = true;
      if (message.result) resolve(message.result); else reject(new Error(message.error || "Process observation failed."));
    });
    worker.once("error", reject);
    worker.once("exit", code => { if (!replied) reject(new Error(`Process observer exited before replying (${code}).`)); });
  });
}
/** Observe the live terminal, never cached agent status or a focused terminal. */
export function appProcessInfo(context: AppContext, paneId: string): AppProcessInfo {
  const terminal = JSON.parse(runAppCore(context, ["get", paneId]));
  if (terminal.address !== paneId || terminal.state !== "live" || !Number.isSafeInteger(terminal.pid) || terminal.pid <= 0) throw new Error("The addressed terminal is not live.");
  if (process.platform === "win32") {
    const info = JSON.parse(execFileSync("powershell.exe", ["-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", fileURLToPath(new URL("./app-process-info.ps1", import.meta.url)), String(terminal.pid)], { encoding: "utf8", windowsHide: true, timeout: 15_000, maxBuffer: 1024 * 1024 }));
    if (info?.shell_pid !== terminal.pid || typeof info.shell_owns_foreground !== "boolean" || !Array.isArray(info.foreground_processes) ||
      (info.shell_owns_foreground && (info.foreground_processes.length !== 1 || info.foreground_processes[0]?.pid !== terminal.pid)) ||
      !info.foreground_processes.every((item: any) => Number.isSafeInteger(item.pid) && item.pid > 0 && typeof item.cwd === "string" && item.cwd.length > 0 && Array.isArray(item.argv) && item.argv.length > 0 && item.argv.every((arg: unknown) => typeof arg === "string"))) throw new Error("Invalid Windows terminal process observation.");
    return { paneId, shellPid: terminal.pid, shellOwnsForeground: info.shell_owns_foreground, foregroundProcesses: info.foreground_processes };
  }
  if (process.platform !== "linux") throw new Error("Terminal process observation is unavailable on this platform.");
  const stat = (pid: number) => {
    const content = readFileSync(`/proc/${pid}/stat`, "utf8");
    const end = content.lastIndexOf(")");
    if (end < 0) throw new Error("Invalid process identity.");
    return content.slice(end + 2).trim().split(/\s+/);
  };
  const shell = stat(terminal.pid);
  const hasTty = Number(shell[4]) !== 0;
  const group = hasTty ? Number(shell[5]) : terminal.foreground?.pid;
  const foregroundProcesses: AppProcessInfo["foregroundProcesses"] = [];
  if (Number.isSafeInteger(group) && group > 0) {
    for (const entry of readdirSync("/proc")) {
      if (!/^\d+$/.test(entry)) continue;
      const pid = Number(entry);
      try {
        const before = stat(pid);
        if (Number(before[2]) !== group || before[3] !== shell[3]) continue;
        const cwd = readlinkSync(`/proc/${pid}/cwd`);
        const argv = readFileSync(`/proc/${pid}/cmdline`, "utf8").split("\0").filter(Boolean);
        const after = stat(pid);
        if (after[19] === before[19] && after[2] === before[2] && after[3] === before[3]) foregroundProcesses.push({ pid, cwd, argv });
      } catch { /* Processes may exit between observations. */ }
    }
  }
  const after = stat(terminal.pid);
  if (shell[19] !== after[19] || shell[3] !== after[3] || shell[4] !== after[4] || shell[5] !== after[5]) throw new Error("Terminal process changed during observation.");
  return { paneId, shellPid: terminal.pid, shellOwnsForeground: hasTty && group === terminal.pid,
    ...(Number.isSafeInteger(group) && group > 0 ? { foregroundProcessGroupId: group } : {}), foregroundProcesses };
}