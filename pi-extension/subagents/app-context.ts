import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

/** A native App terminal and the core connection that owns its IDs. */
export interface AppContext {
  paneId: string;
  tabId: string;
  workspaceId: string;
  session: string;
  coreSocketPath?: string;
  stateHome?: string;
  configHome?: string;
  runtimeDir?: string;
  appHome?: string;
  appCli?: string;
  appMachine?: string;
  appRoute?: { socket: string; token: string; operationId: string };
  appSsh?: { target: string; session?: string; stateHome?: string; configHome?: string; runtimeDir?: string; appHome?: string; appCli?: string; coreSocketPath?: string };
}

/** Identify an App terminal using its own core, never the focused window. */
export function getAppContext(env: NodeJS.ProcessEnv = process.env): AppContext | undefined {
  const paneId = env.HC_TERMINAL_ID?.trim();
  if (!paneId) return;
  if (env.HC_SOCKET && env.HC_TERMINAL_SOCKET && env.HC_SOCKET !== env.HC_TERMINAL_SOCKET) throw new Error("The terminal belongs to another core socket.");
  const context: AppContext = {
    paneId, tabId: "", workspaceId: "", session: env.HC_SESSION || "default",
    coreSocketPath: env.HC_TERMINAL_SOCKET || env.HC_SOCKET,
    stateHome: env.XDG_STATE_HOME, configHome: env.XDG_CONFIG_HOME, runtimeDir: env.XDG_RUNTIME_DIR,
    appHome: env.HERDR_APP_HOME, appCli: env.PI_HERDR_APP_CLI,
  };
  if (env.PI_TELEPORT_APP_CONTEXT) {
    const saved = JSON.parse(readFileSync(env.PI_TELEPORT_APP_CONTEXT, "utf8"));
    const controller = saved.appRoute && [saved.appRoute.socket, saved.appRoute.token, saved.appRoute.operationId].every((v: unknown) => typeof v === "string" && v.length > 0);
    const ssh = typeof saved.appSsh?.target === "string" && /^(?:[A-Za-z0-9][A-Za-z0-9_.-]*@)?[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(saved.appSsh.target);
    if (saved.backend !== "app" || saved.session !== context.session || typeof saved.appMachine !== "string" || !saved.appMachine || saved.appMachine.includes("/") || !(saved.appRoute ? controller && !saved.appSsh : ssh)) throw new Error("The saved App route does not match this core connection.");
    context.appMachine = saved.appMachine;
    context.appRoute = saved.appRoute;
    context.appSsh = saved.appSsh;
  }
  const coreEnv: NodeJS.ProcessEnv = { ...env, HC_SESSION: context.session, HC_TERMINAL_ID: paneId };
  delete coreEnv.HC_SCOPE;
  const terminal = JSON.parse(execFileSync("hc", ["get", paneId], { env: coreEnv, encoding: "utf8", timeout: 15_000, stdio: ["ignore", "pipe", "pipe"] }));
  if (terminal.address !== paneId || terminal.state !== "live" || typeof terminal.labels?.["herdr.space"] !== "string" || !terminal.labels["herdr.space"] || typeof terminal.labels?.["herdr.tab"] !== "string" || !terminal.labels["herdr.tab"]) throw new Error("The terminal has no verified App workspace and tab.");
  context.workspaceId = terminal.labels["herdr.space"];
  context.tabId = terminal.labels["herdr.tab"];
  return context;
}
