import { runApp } from "./app-transport.js";
function uiId(context, id) {
    if (!id || id.includes("/"))
        throw new Error("Expected an unqualified core handle.");
    return context.appMachine ? `${context.appMachine}/${id}` : id;
}
function coreId(context, value) {
    if (typeof value !== "string")
        throw new Error("App returned no native handle.");
    const prefix = context.appMachine ? `${context.appMachine}/` : "";
    if (!value.startsWith(prefix))
        throw new Error("App returned a handle for another machine.");
    const id = value.slice(prefix.length);
    if (!id || id.includes("/"))
        throw new Error("App returned a handle outside the connected machine.");
    return id;
}
function createItem(context, command, args) {
    const result = runApp(context, ["do", command, JSON.stringify({ ...args, focus: false })]);
    return { workspaceId: coreId(context, result.space), tabId: coreId(context, result.tab), paneId: coreId(context, result.terminal) };
}
export function createAppTab(context, workspaceId, cwd, name) {
    const result = createItem(context, "tab.new", { space: uiId(context, workspaceId), folder: cwd, name });
    if (result.workspaceId !== workspaceId)
        throw new Error("App created the tab in a different workspace.");
    return result;
}
export function createAppWorkspace(context, cwd, name) {
    return createItem(context, "space.new", { folder: cwd, name, tab: name, machine: context.appMachine || "" });
}
export function appSpaces(context) {
    const result = runApp(context, ["ls"]);
    if (!Array.isArray(result.spaces))
        throw new Error("App returned no spaces.");
    return result.spaces.filter((space) => context.appMachine ? space.machine === context.appMachine : !space.machine).map((space) => ({
        id: coreId(context, space.id), ...(typeof space.name === "string" ? { name: space.name } : {}),
        ...(typeof space.folder === "string" ? { folder: space.folder } : {}),
        tabs: space.tabs.map((tab) => ({
            id: coreId(context, tab.id), ...(typeof tab.name === "string" ? { name: tab.name } : {}),
            terminals: tab.terminals.map((pane) => ({ terminal: coreId(context, pane.terminal), pane: coreId(context, pane.pane) })),
        })),
    }));
}
/** Park only the owned terminal, leaving other panes in its tab untouched. */
export function parkAppTerminal(context, paneId) {
    const terminal = uiId(context, paneId);
    const result = runApp(context, ["do", "terminal.park", JSON.stringify({ terminal })]);
    if (result.pending !== true || result.terminal !== terminal)
        throw new Error("App did not acknowledge parking the terminal.");
    const deadline = Date.now() + 15_000;
    while (appSpaces(context).some((space) => space.tabs.some((tab) => tab.terminals.some((pane) => pane.terminal === paneId)))) {
        if (Date.now() >= deadline)
            throw new Error("App has not confirmed removing the terminal pane; the terminal is retained.");
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);
    }
}
export function closeAppTab(context, tabId) {
    runApp(context, ["do", "tab.close", JSON.stringify({ id: uiId(context, tabId), confirmed: true })]);
}
export function closeAppWorkspace(context, workspaceId) {
    runApp(context, ["do", "space.close", JSON.stringify({ id: uiId(context, workspaceId), confirmed: true })]);
}
