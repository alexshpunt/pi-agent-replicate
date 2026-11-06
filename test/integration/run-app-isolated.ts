/**
 * Private native App runner. DISPLAY may name a task-owned headless display;
 * the window, core connection, home and every checkout belong to this run.
 */
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, openSync, closeSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const project = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const files = process.argv.slice(2);
if (!files.length || files.some(file => !file.endsWith(".test.ts"))) throw new Error("Pass an explicit integration test file list.");
const binary = process.env.PI_INTEGRATION_APP_BIN;
if (!binary || !isAbsolute(binary) || !existsSync(binary)) throw new Error("PI_INTEGRATION_APP_BIN must identify a native App executable.");
const parent = join(project, ".agents", "tmp");
mkdirSync(parent, { recursive: true });
const root = mkdtempSync(join(parent, "app-integration-"));
const env = { ...process.env };
for (const key of Object.keys(env)) {
  if (/^(HC_|HERDR_|PI_SUBAGENT_|PI_TELEPORT_)/.test(key)) delete env[key];
}
delete env.PI_DENY_TOOLS;
Object.assign(env, {
  HOME: join(root, "home"), XDG_CONFIG_HOME: join(root, "config"),
  XDG_STATE_HOME: join(root, "state"), XDG_RUNTIME_DIR: join("/tmp", "ra-" + root.split("-").at(-1)),
  HERDR_APP_HOME: join("/tmp", "ra-" + root.split("-").at(-1), "app"), HERDR_APP_NO_SOUND: "1", WAYLAND_DISPLAY: "",
  HC_SESSION: "replicate-" + root.split("-").at(-1), PI_HERDR_APP_CLI: binary,
  PI_CODING_AGENT_DIR: join(root, "agent"), PI_INTEGRATION_HERDR_RUN_DIR: root,
});
for (const key of ["HOME", "XDG_CONFIG_HOME", "XDG_STATE_HOME", "XDG_RUNTIME_DIR", "HERDR_APP_HOME", "PI_CODING_AGENT_DIR"]) mkdirSync(env[key]!, { recursive: true, mode: 0o700 });
const log = openSync(join(root, "app.log"), "w");
type Identity = { pid: number; birth: string; group: number };
const groups: Identity[] = [];
let core: Identity | undefined;
let child: ChildProcess | undefined;
let app: ChildProcess | undefined;
let exitCode = 1;
let shutdownPromise: Promise<void> | undefined;
function identity(pid: number): Identity | undefined {
  try {
    const raw = readFileSync(`/proc/${pid}/stat`, "utf8");
    const fields = raw.slice(raw.lastIndexOf(")") + 2).split(/\s+/);
    return { pid, birth: fields[19], group: Number(fields[2]) };
  } catch { return; }
}
function tracked(command: string, args: string[]): ChildProcess {
  const process = spawn(command, args, { env, detached: true, stdio: ["ignore", log, log] });
  if (!process.pid) throw new Error("The isolated process has no PID.");
  const own = identity(process.pid);
  if (!own || own.group !== process.pid) throw new Error("The isolated process group could not be verified.");
  groups.push(own);
  process.on("error", error => console.error(error));
  return process;
}
function cli(command: string, args: string[], json = true): any {
  const result = spawnSync(command, args, { env, encoding: "utf8", timeout: 15_000 });
  if (result.status !== 0) throw new Error(result.stderr || result.stdout || "The private CLI request failed.");
  return json ? JSON.parse(result.stdout) : result.stdout;
}
async function until(check: () => boolean, timeout = 20_000): Promise<void> {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (check()) return;
    await new Promise(resolveWait => setTimeout(resolveWait, 50));
  }
  throw new Error("The private App did not reach the expected state.");
}
async function stopGroup(own: Identity): Promise<void> {
  const current = identity(own.pid);
  if (current && (current.birth !== own.birth || current.group !== own.group)) throw new Error("Process group ownership changed.");
  for (const signal of ["SIGTERM", "SIGKILL"] as const) {
    try { process.kill(-own.group, signal); } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ESRCH") return;
      throw error;
    }
    const deadline = Date.now() + 2_000;
    while (Date.now() < deadline) {
      try { process.kill(-own.group, 0); } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ESRCH") return;
      }
      await new Promise(resolveWait => setTimeout(resolveWait, 25));
    }
  }
  throw new Error("The private process group is still live.");
}
function shutdown(): Promise<void> {
  return shutdownPromise ??= (async () => {
    try {
      for (const own of [...groups].reverse()) await stopGroup(own);
      // End programs before stopping the core: kept terminals must not be parked
      // with a surviving process when their checkout is removed.
      const terminals = cli("hc", ["ls", "--all"]);
      for (const terminal of Array.isArray(terminals) ? terminals : terminals.terminals ?? []) {
        if (terminal.state === "live") cli("hc", ["kill", terminal.address]);
        cli("hc", ["rm", terminal.address]);
      }
      cli("hc", ["server", "stop"]);
      if (core) await until(() => identity(core!.pid)?.birth !== core!.birth);
      if (process.env.PI_INTEGRATION_APP_EVIDENCE) {
        mkdirSync(process.env.PI_INTEGRATION_APP_EVIDENCE, { recursive: true });
        for (const name of ["app.log", "runtime.json"]) if (existsSync(join(root, name))) {
          writeFileSync(join(process.env.PI_INTEGRATION_APP_EVIDENCE, name), readFileSync(join(root, name)));
        }
      }
      rmSync(root, { recursive: true, force: true });
      rmSync(env.XDG_RUNTIME_DIR!, { recursive: true, force: true });
    } catch (error) {
      exitCode = 1;
      console.error("Isolated App teardown failed; retained " + root, error);
    }
    closeSync(log);
  })();
}
for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) process.once(signal, () => {
  exitCode = signal === "SIGINT" ? 130 : 143;
  void shutdown().then(() => { process.exitCode = exitCode; });
});
try {
  console.log("Private native App root: " + root);
  console.log("Private core start: " + JSON.stringify(cli("hc", ["server", "start"])));
  const status = cli("hc", ["server", "status"]);
  console.log("Private core status: " + JSON.stringify(status));
  const pid = status.pid ?? status.server?.pid;
  if (Number.isSafeInteger(pid)) core = identity(pid);
  app = tracked(binary, []);
  await until(() => {
    if (app!.exitCode !== null) throw new Error("The private App window exited.");
    try { cli(binary, ["status"]); return true; } catch { return false; }
  });
  cli(binary, ["do", "overlay.close", JSON.stringify({ id: "welcome" })]);
  const source = cli(binary, ["do", "space.new", JSON.stringify({ name: "integration-root", folder: env.HOME, tab: "source" })]);
  if (!source.terminal || !source.space || !source.tab) throw new Error("The private source surface is incomplete.");
  env.HC_TERMINAL_ID = source.terminal;
  writeFileSync(join(root, "runtime.json"), JSON.stringify({ app: binary, core: status, source, files }));
  child = spawn(process.execPath, ["--experimental-strip-types", "--test", "--test-concurrency=1", ...files], { env, detached: true, stdio: "inherit" });
  if (!child.pid) throw new Error("The integration child did not start.");
  const childIdentity = identity(child.pid);
  if (!childIdentity || childIdentity.group !== child.pid) throw new Error("The integration child group is unknown.");
  groups.push(childIdentity);
  exitCode = await new Promise<number>(resolveExit => { child!.once("exit", code => resolveExit(code ?? 1)); child!.once("error", () => resolveExit(1)); });
} catch (error) { console.error(error); }
finally { await shutdown(); }
process.exitCode = exitCode;
