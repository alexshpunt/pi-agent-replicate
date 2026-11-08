import type { AppContext } from "./app-context.ts";
import { runApp } from "./app-transport.ts";

export interface AppSpace {
  id: string;
  name?: string;
  folder?: string;
  tabs: Array<{ id: string; name?: string; terminals: Array<{ terminal: string; pane: string }> }>;
}
export interface AppLocation { workspaceId: string; tabId: string; paneId: string }

function uiId(context: AppContext, id: string): string {
  if (!id || id.includes("/")) throw new Error("Expected an unqualified core handle.");
  return context.appMachine ? `${context.appMachine}/${id}` : id;
}
function coreId(context: AppContext, value: unknown): string {
  if (typeof value !== "string") throw new Error("App returned no native handle.");
  const prefix = context.appMachine ? `${context.appMachine}/` : "";
  if (!value.startsWith(prefix)) throw new Error("App returned a handle for another machine.");
  const id = value.slice(prefix.length);
  if (!id || id.includes("/")) throw new Error("App returned a handle outside the connected machine.");
  return id;
}
function createItem(context: AppContext, command: "space.new" | "tab.new", args: Record<string, unknown>): AppLocation {
  const result = runApp(context, ["do", command, JSON.stringify({ ...args, focus: false })]);
  return { workspaceId: coreId(context, result.space), tabId: coreId(context, result.tab), paneId: coreId(context, result.terminal) };
}
export function createAppTab(context: AppContext, workspaceId: string, cwd: string, name: string): AppLocation {
  const result = createItem(context, "tab.new", { space: uiId(context, workspaceId), folder: cwd, name });
  if (result.workspaceId !== workspaceId) throw new Error("App created the tab in a different workspace.");
  return result;
}
export function createAppWorkspace(context: AppContext, cwd: string, name: string): AppLocation {
  return createItem(context, "space.new", { folder: cwd, name, tab: name, machine: context.appMachine || "" });
}
export function appSpaces(context: AppContext): AppSpace[] {
  const result = runApp(context, ["ls"]);
  if (!Array.isArray(result.spaces)) throw new Error("App returned no spaces.");
  return result.spaces.filter((space: any) => context.appMachine ? space.machine === context.appMachine : !space.machine).map((space: any) => ({
    id: coreId(context, space.id), ...(typeof space.name === "string" ? { name: space.name } : {}),
    ...(typeof space.folder === "string" ? { folder: space.folder } : {}),
    tabs: space.tabs.map((tab: any) => ({
      id: coreId(context, tab.id), ...(typeof tab.name === "string" ? { name: tab.name } : {}),
      terminals: tab.terminals.map((pane: any) => ({ terminal: coreId(context, pane.terminal), pane: coreId(context, pane.pane) })),
    })),
  }));
}
/** Park only the owned terminal, leaving other panes in its tab untouched. */
export function parkAppTerminal(context: AppContext, paneId: string): void {
  const terminal = uiId(context, paneId);
  const result = runApp(context, ["do", "terminal.park", JSON.stringify({ terminal })]);
  if (result.pending !== true || result.terminal !== terminal) throw new Error("App did not acknowledge parking the terminal.");
  const deadline = Date.now() + 15_000;
  while (appSpaces(context).some((space) => space.tabs.some((tab) => tab.terminals.some((pane) => pane.terminal === paneId)))) {
    if (Date.now() >= deadline) throw new Error("App has not confirmed removing the terminal pane; the terminal is retained.");
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);
  }
}
export function closeAppTab(context: AppContext, tabId: string): void {
  runApp(context, ["do", "tab.close", JSON.stringify({ id: uiId(context, tabId), confirmed: true })]);
}
export function closeAppWorkspace(context: AppContext, workspaceId: string): void {
  runApp(context, ["do", "space.close", JSON.stringify({ id: uiId(context, workspaceId), confirmed: true })]);
}
