/// <reference types="node" />
import { execFile, execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, readlinkSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { createConnection } from "node:net";

const execAsync = promisify(execFile);
const modulePath = fileURLToPath(import.meta.url);
type Route = { socket: string; token: string; operationId: string };
type SshRoute = { target: string; session?: string; stateHome?: string; configHome?: string; runtimeDir?: string; appHome?: string; appCli?: string; coreSocketPath?: string };
type Context = { appMachine?: string; appRoute?: Route; appSsh?: SshRoute };
type Space = { id: string; folder?: string; machine?: string; tabs: Array<{ id: string; name?: string; terminals: Array<{ terminal: string; pane: string }> }> };

/** App core handles are local to this process's core connection. */
export function inHerdrApp(): boolean { return !!process.env.HC_TERMINAL_ID?.trim(); }
function coreEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  delete env.HC_SCOPE;
  if (env.HC_SOCKET && env.HC_TERMINAL_SOCKET && env.HC_SOCKET !== env.HC_TERMINAL_SOCKET) throw new Error("Conflicting App core sockets.");
  return env;
}
export function appCore(args: string[], text = false): any {
  const output = execFileSync("hc", args, { env: coreEnv(), encoding: "utf8", timeout: 15_000, stdio: ["ignore", "pipe", "pipe"] });
  return text ? output : JSON.parse(output);
}
export function currentAppPane(): { pane_id: string; tab_id: string; workspace_id: string } {
  const id = process.env.HC_TERMINAL_ID;
  if (!id) throw new Error("No native App terminal.");
  const terminal = appCore(["get", id]);
  if (terminal.address !== id || terminal.state !== "live" ||
      typeof terminal.labels?.["herdr.space"] !== "string" || !terminal.labels["herdr.space"] ||
      typeof terminal.labels?.["herdr.tab"] !== "string" || !terminal.labels["herdr.tab"]) throw new Error("The current core terminal has no live App ownership.");
  return { pane_id: id, tab_id: terminal.labels["herdr.tab"], workspace_id: terminal.labels["herdr.space"] };
}
function context(): Context {
  if (!process.env.PI_TELEPORT_APP_CONTEXT) return {};
  const saved = JSON.parse(readFileSync(process.env.PI_TELEPORT_APP_CONTEXT, "utf8"));
  const route = saved.appRoute && [saved.appRoute.socket, saved.appRoute.token, saved.appRoute.operationId].every((value: unknown) => typeof value === "string" && value.length > 0);
  const ssh = typeof saved.appSsh?.target === "string" && /^(?:[A-Za-z0-9][A-Za-z0-9_.-]*@)?[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(saved.appSsh.target);
  if (saved.backend !== "app" || saved.session !== (process.env.HC_SESSION || "default") || !saved.appMachine || saved.appMachine.includes("/") || !(saved.appRoute ? route && !saved.appSsh : ssh)) throw new Error("The saved App UI route does not match this core connection.");
  return saved;
}
class AppCommandError extends Error {}
function uiId(id: string): string {
  if (!id || id.includes("/")) throw new Error("Expected an unqualified core handle.");
  const machine = context().appMachine;
  return machine ? `${machine}/${id}` : id;
}
function coreId(id: unknown): string {
  const prefix = context().appMachine ? context().appMachine + "/" : "";
  if (typeof id !== "string" || !id.startsWith(prefix) || !id.slice(prefix.length) || id.slice(prefix.length).includes("/")) throw new Error("The App handle belongs to another machine.");
  return id.slice(prefix.length);
}
function app(args: string[]): any {
  const ctx = context();
  let output: string;
  if (ctx.appRoute) {
    try { output = execFileSync(process.execPath, ["--experimental-strip-types", modulePath, "--route"], { input: JSON.stringify({ route: ctx.appRoute, args }), encoding: "utf8", timeout: 45_000, maxBuffer: 16 * 1024 * 1024, stdio: ["pipe", "pipe", "pipe"] }); }
    catch { throw new Error("The App UI outcome is unconfirmed; the request was not replayed."); }
    const reply = JSON.parse(output);
    if (reply.ok !== true) throw new Error(reply.error || "The App UI outcome is unconfirmed.");
    if (typeof reply.result?.error === "string") throw new AppCommandError(reply.result.error);
    return reply.result;
  }
  try {
    if (ctx.appSsh) {
      const script = `const cfg=${JSON.stringify({ ...ctx.appSsh, args })};const env={...process.env,HC_SESSION:cfg.session||'default'};for(const [k,v] of Object.entries({HC_SOCKET:cfg.coreSocketPath,HC_TERMINAL_SOCKET:cfg.coreSocketPath,HC_TERMINAL_ID:undefined,HC_SCOPE:undefined,XDG_STATE_HOME:cfg.stateHome,XDG_CONFIG_HOME:cfg.configHome,XDG_RUNTIME_DIR:cfg.runtimeDir,HERDR_APP_HOME:cfg.appHome})){if(v===undefined)delete env[k];else env[k]=v;}try{process.stdout.write(require('node:child_process').execFileSync(cfg.appCli||(process.platform==='win32'?'herdr-app.exe':'herdr-app'),cfg.args,{env,encoding:'utf8',timeout:40000,maxBuffer:16777216,windowsHide:true,stdio:['ignore','pipe','pipe']}));}catch(e){if(e.stdout)process.stdout.write(e.stdout);process.exitCode=1;}`;
      output = execFileSync("ssh", ["-o", "BatchMode=yes", "-o", "ConnectTimeout=10", "-o", "StrictHostKeyChecking=yes", ctx.appSsh.target, `node -e "eval(Buffer.from('${Buffer.from(script).toString("base64")}','base64').toString())"`], { encoding: "utf8", timeout: 60_000, maxBuffer: 16 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"] });
    } else output = execFileSync(process.env.PI_HERDR_APP_CLI || "herdr-app", args, { env: coreEnv(), encoding: "utf8", timeout: 40_000, stdio: ["ignore", "pipe", "pipe"] });
  } catch (error) {
    const stdout = (error as { stdout?: Buffer | string }).stdout?.toString();
    if (!stdout?.trim()) throw error;
    output = stdout;
  }
  const reply = JSON.parse(output);
  if (!reply || typeof reply !== "object") throw new Error("App returned no structured response.");
  if (typeof reply.error === "string") throw new AppCommandError(reply.error);
  return reply;
}
function operation(name: string, payload: Record<string, unknown>): any { return app(["do", name, JSON.stringify(payload)]); }
function createItem(name: string, payload: Record<string, unknown>): any {
  try { return operation(name, { ...payload, focus: false }); }
  catch (error) {
    // Only this pre-execution validation verdict permits retry without focus.
    if (!(error instanceof AppCommandError) || !error.message.startsWith(`${name}: unknown argument(s): focus; valid arguments: `)) throw error;
    return operation(name, payload);
  }
}
function spaces(): Space[] {
  const reply = app(["ls"]);
  if (!Array.isArray(reply.spaces)) throw new Error("App returned no space inventory.");
  const machine = context().appMachine;
  return reply.spaces.filter((space: Space) => machine ? space.machine === machine : !space.machine).map((space: Space) => ({
    ...space, id: coreId(space.id), tabs: space.tabs.map(tab => ({ ...tab, id: coreId(tab.id), terminals: tab.terminals.map(pane => ({ terminal: coreId(pane.terminal), pane: coreId(pane.pane) })) })),
  }));
}
function creation(reply: any): any {
  const workspace_id = coreId(reply.space), tab_id = coreId(reply.tab), pane_id = coreId(reply.terminal);
  return { workspace: { workspace_id }, tab: { tab_id, workspace_id }, root_pane: { pane_id, tab_id, workspace_id } };
}
function terminalList(): any[] {
  const reply = appCore(["ls", "--all"]), list = Array.isArray(reply) ? reply : reply.terminals;
  if (!Array.isArray(list) || list.some(terminal => typeof terminal.address !== "string")) throw new Error("The core terminal inventory is invalid.");
  return list;
}
function stat(pid: number): string[] {
  const text = readFileSync(`/proc/${pid}/stat`, "utf8");
  return text.slice(text.lastIndexOf(")") + 2).trim().split(/\s+/);
}
function processInfo(id: string): any {
  if (process.platform !== "linux") throw new Error("Native App process ownership is not implemented on this platform.");
  const terminal = appCore(["get", id]);
  if (terminal.address !== id || terminal.state !== "live" || !Number.isSafeInteger(terminal.pid)) throw new Error("The addressed core terminal is not live.");
  const shell = stat(terminal.pid), group = Number(shell[4]) !== 0 ? Number(shell[5]) : terminal.foreground?.pid;
  const foreground_processes: Array<{ pid: number; cwd: string; argv: string[]; name: string; argv0: string }> = [];
  for (const entry of readdirSync("/proc")) {
    if (!/^\d+$/.test(entry)) continue;
    const pid = Number(entry);
    try {
      const before = stat(pid);
      if (Number(before[2]) !== group || before[3] !== shell[3]) continue;
      const cwd = readlinkSync(`/proc/${pid}/cwd`), argv = readFileSync(`/proc/${pid}/cmdline`, "utf8").split("\0").filter(Boolean), after = stat(pid);
      if (after[19] === before[19] && after[2] === before[2] && after[3] === before[3] && argv.length) foreground_processes.push({ pid, cwd, argv, name: argv[0].split("/").at(-1)!, argv0: argv[0] });
    } catch { /* A foreground process can exit during observation. */ }
  }
  if (stat(terminal.pid)[19] !== shell[19]) throw new Error("The terminal process incarnation changed.");
  return { pane_id: id, shell_pid: terminal.pid, foreground_process_group_id: group, foreground_processes };
}
function pause(): void { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50); }
/** Park through the public UI before ending the terminal; never close its last pane. */
export function closeAppPane(id: string): void {
  const inventory = spaces(), space = inventory.find(space => space.tabs.some(tab => tab.terminals.some(pane => pane.terminal === id)));
  const tab = space?.tabs.find(tab => tab.terminals.some(pane => pane.terminal === id));
  if (tab && tab.terminals.length !== 1) throw new Error("The owned tab contains another terminal.");
  const listed = terminalList().find(terminal => terminal.address === id);
  const terminal = listed ? appCore(["get", id]) : undefined;
  if (terminal && terminal.address !== id) throw new Error("The core returned another terminal.");
  if (tab) {
    if (terminal?.labels?.["herdr.space"] !== space!.id || terminal.labels?.["herdr.tab"] !== tab.id) throw new Error("The terminal's App ownership changed.");
    const reply = operation("terminal.park", { terminal: uiId(id) });
    if (reply.pending !== true || reply.terminal !== uiId(id)) throw new Error("App did not acknowledge this terminal's parking.");
    const deadline = Date.now() + 15_000;
    while (spaces().some(space => space.tabs.some(tab => tab.terminals.some(pane => pane.terminal === id)))) {
      if (Date.now() >= deadline) throw new Error("App has not removed the terminal's pane; the core terminal was retained.");
      pause();
    }
  }
  if (terminal) {
    const birth = terminal.state === "live" ? stat(terminal.pid)[19] : undefined;
    if (terminal.state === "live") appCore(["kill", id]);
    const deadline = Date.now() + 15_000;
    while (birth && existsSync(`/proc/${terminal.pid}`) && stat(terminal.pid)[19] === birth) {
      if (Date.now() >= deadline) throw new Error("The owned terminal process has not exited.");
      pause();
    }
    appCore(["rm", id]);
  }
  if (space) {
    const remaining = spaces().find(candidate => candidate.id === space.id);
    if (remaining && remaining.tabs.length === 0) operation("space.close", { id: uiId(space.id), confirmed: true });
  }
}
function git(cwd: string, args: string[]): string { return execFileSync("git", args, { cwd, encoding: "utf8", timeout: 15_000, stdio: ["ignore", "pipe", "pipe"] }); }
function worktrees(cwd: string): any[] {
  const inventory = spaces();
  const records = git(cwd, ["worktree", "list", "--porcelain", "-z"]).split("\0\0").filter(Boolean);
  return records.map((record, index) => {
    const fields = record.split("\0"), path = fields.find(field => field.startsWith("worktree "))?.slice(9);
    if (!path) throw new Error("Git returned an incomplete worktree inventory.");
    const branch = fields.find(field => field.startsWith("branch refs/heads/"))?.slice(18);
    const matches = inventory.filter(space => space.folder && realpathSync(space.folder) === realpathSync(path));
    if (matches.length > 1) throw new Error("Multiple App spaces own this checkout.");
    return { path, branch, is_detached: !branch, is_linked_worktree: index !== 0, ...(matches[0] ? { open_workspace_id: matches[0].id } : {}) };
  });
}
export class AppWorktreeCreateError extends Error {
  readonly recoveredWorktree: { path: string; branch: string };
  constructor(message: string, recoveredWorktree: { path: string; branch: string }) { super(message); this.recoveredWorktree = recoveredWorktree; }
}
/** Internal compatibility envelope: existing lifecycle guards stay authoritative. */
export function appExec(args: string[]): string {
  const [kind, action] = args;
  const option = (name: string) => { const index = args.indexOf(name); if (index < 0 || !args[index + 1]) throw new Error(`Missing ${name}.`); return args[index + 1]; };
  const result = (value: unknown) => JSON.stringify({ result: value });
  if (kind === "pane" && action === "current") return result({ pane: currentAppPane() });
  if (kind === "pane" && action === "get") {
    const terminal = terminalList().find(terminal => terminal.address === args[2]);
    if (!terminal) return JSON.stringify({ error: { code: "pane_not_found" } });
    return result({ pane: { pane_id: terminal.address, tab_id: terminal.labels?.["herdr.tab"], workspace_id: terminal.labels?.["herdr.space"], agent_status: "unknown" } });
  }
  if (kind === "pane" && action === "process-info") return result({ process_info: processInfo(option("--pane")) });
  if (kind === "pane" && action === "read") return appCore(["read", args[2], "--lines", option("--lines")], true);
  if (kind === "pane" && action === "send-keys" && args.length === 4 && args[3] === "Escape") { appCore(["keys", args[2], "esc"]); return result({ type: "ok" }); }
  if (kind === "pane" && action === "run") { appCore(["send", args[2], args[3]]); return result({ type: "ok" }); }
  if (kind === "pane" && action === "rename") return result({ type: "ok" }); // App names the owning tab.
  if (kind === "pane" && action === "list") {
    const workspace = option("--workspace"), space = spaces().find(space => space.id === workspace);
    if (!space) throw new Error("The addressed App space is unavailable.");
    return result({ type: "pane_list", panes: space.tabs.flatMap(tab => tab.terminals.map(pane => ({ pane_id: pane.terminal, tab_id: tab.id, workspace_id: workspace }))) });
  }
  if (kind === "tab" && action === "create") return result(creation(createItem("tab.new", { space: uiId(option("--workspace")), folder: option("--cwd"), name: option("--label") })));
  if (kind === "tab" && action === "rename") return result(operation("tab.rename", { id: uiId(args[2]), name: args[3] }));
  if (kind === "worktree" && action === "list") return result({ type: "worktree_list", worktrees: worktrees(args.includes("--cwd") ? option("--cwd") : process.cwd()) });
  if (kind === "worktree" && action === "create") {
    const cwd = option("--cwd"), branch = option("--branch"), common = git(cwd, ["rev-parse", "--path-format=absolute", "--git-common-dir"]).trim();
    const hash = (value: string) => createHash("sha256").update(value).digest("hex");
    const parent = join(process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent"), "replica-worktrees", hash(common));
    mkdirSync(parent, { recursive: true });
    const path = join(parent, hash(branch));
    if (existsSync(path)) throw new Error("The App replica checkout path is occupied.");
    git(cwd, ["check-ref-format", "--branch", branch]);
    let branchExists = false;
    try { git(cwd, ["show-ref", "--verify", "--quiet", "refs/heads/" + branch]); branchExists = true; }
    catch (error) { if ((error as { status?: number }).status !== 1) throw error; }
    git(cwd, branchExists ? ["worktree", "add", "--", path, branch] : ["worktree", "add", "-b", branch, "--", path, option("--base")]);
    try {
      const created = creation(createItem("space.new", { folder: path, name: option("--label"), tab: option("--label"), machine: context().appMachine || "" }));
      return result({ ...created, type: "worktree_created", worktree: { path, branch } });
    } catch (error) { throw new AppWorktreeCreateError(String(error), { path, branch }); }
  }
  if (kind === "worktree" && action === "remove") {
    const workspace = option("--workspace"), space = spaces().find(space => space.id === workspace);
    if (!space?.folder || space.tabs.length !== 1 || space.tabs[0].terminals.length !== 1) throw new Error("The replica workspace is not exclusively owned.");
    const path = space.folder;
    closeAppPane(space.tabs[0].terminals[0].terminal);
    const remaining = spaces().find(space => space.id === workspace);
    if (remaining) {
      if (remaining.tabs.some(tab => tab.terminals.length)) throw new Error("The replica space is still occupied.");
      operation("space.close", { id: uiId(workspace), confirmed: true });
    }
    // The caller already verified its source checkpoint and durable shell identity.
    git(process.cwd(), ["worktree", "remove", "--force", path]);
    return result({ type: "ok" });
  }
  throw new Error(`Native App operation is not implemented: ${kind} ${action}.`);
}
/** Polling runs in a short-lived helper, not on the interactive Pi event loop. */
export async function appExecAsync(args: string[]): Promise<string> {
  const { stdout } = await execAsync(process.execPath, ["--experimental-strip-types", modulePath, "--exec", ...args], { env: process.env, encoding: "utf8", timeout: 65_000, maxBuffer: 16 * 1024 * 1024 });
  return stdout;
}
if (process.argv[1] === modulePath && process.argv[2] === "--exec") process.stdout.write(appExec(process.argv.slice(3)));
if (process.argv[1] === modulePath && process.argv[2] === "--route") {
  const request = JSON.parse(readFileSync(0, "utf8"));
  void new Promise<void>((resolveReply, reject) => {
    const socket = createConnection(request.route.socket);
    let buffer = "";
    socket.setTimeout(40_000, () => socket.destroy(new Error("App controller request timed out.")));
    socket.once("connect", () => socket.write(JSON.stringify({ action: "app", token: request.route.token, args: request.args }) + "\n"));
    socket.on("data", chunk => { buffer += chunk; const end = buffer.indexOf("\n"); if (end >= 0) { process.stdout.write(buffer.slice(0, end)); socket.end(); resolveReply(); } });
    socket.once("error", reject);
    socket.once("end", () => { if (!buffer.includes("\n")) reject(new Error("App controller closed without a receipt.")); });
  });
}
