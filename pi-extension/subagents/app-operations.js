import { runApp } from "./app-transport.js";
/**
 * The machine name under which the App lists this core's terminals, or "" for the App's own
 * machine. A WSL core shown by the Windows App is such a machine ("<name>/<id>" handles). A
 * saved Teleport route or PI_HERDR_APP_MACHINE sets it; otherwise the App's listing tells, by the
 * terminal, tab and space this terminal is known by, and the answer is kept on the context.
 */
export function appMachine(context) {
    if (context.appMachine !== undefined)
        return context.appMachine;
    const result = runApp(context, ["ls"]);
    if (!Array.isArray(result.spaces))
        throw new Error("App returned no spaces.");
    const machines = new Set();
    for (const space of result.spaces) {
        const machine = typeof space?.machine === "string" ? space.machine : "";
        const qualify = (id) => machine ? `${machine}/${id}` : id;
        if (space?.id !== qualify(context.workspaceId) || !Array.isArray(space.tabs))
            continue;
        for (const tab of space.tabs) {
            if (tab?.id !== qualify(context.tabId) || !Array.isArray(tab.terminals))
                continue;
            if (tab.terminals.some((pane) => pane?.terminal === qualify(context.paneId)))
                machines.add(machine);
        }
    }
    if (machines.size !== 1) {
        throw new Error(`The Herdr App ${machines.size ? "lists this terminal on several machines" : "does not list this terminal"}. Set PI_HERDR_APP_MACHINE to its machine name, or to an empty value for the App's own machine.`);
    }
    context.appMachine = [...machines][0];
    return context.appMachine;
}
function uiId(context, id) {
    if (!id || id.includes("/"))
        throw new Error("Expected an unqualified core handle.");
    const machine = appMachine(context);
    return machine ? `${machine}/${id}` : id;
}
function coreId(context, value) {
    if (typeof value !== "string")
        throw new Error("App returned no native handle.");
    const machine = appMachine(context);
    const prefix = machine ? `${machine}/` : "";
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
    return createItem(context, "space.new", { folder: cwd, name, tab: name, machine: appMachine(context) });
}
export function appSpaces(context) {
    const result = runApp(context, ["ls"]);
    if (!Array.isArray(result.spaces))
        throw new Error("App returned no spaces.");
    const machine = appMachine(context);
    return result.spaces.filter((space) => machine ? space.machine === machine : !space.machine).map((space) => ({
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
