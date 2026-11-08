import { appProcessInfo, runAppCore } from "./app-core.js";
import { appSpaces, parkAppTerminal } from "./app-operations.js";
import { captureLaunchPaneOwnership } from "./session-binding.js";
/** Retire one proven shell; never close a tab containing other user panes. */
export function retireAppTerminal(paneId, shellPid, saved, ops, options) {
    const core = ops.coreIdentity();
    if (!core.id || !core.start || !core.bootId || !Number.isSafeInteger(core.pid) || core.pid <= 0)
        return false;
    const sameCore = () => { const now = ops.coreIdentity(); return now.id === core.id && now.pid === core.pid && now.start === core.start && now.bootId === core.bootId; };
    if (saved && (saved.paneId !== paneId || saved.shellPid !== shellPid || saved.coreId !== core.id || saved.corePid !== core.pid || saved.coreStart !== core.start || saved.bootId !== core.bootId))
        return false;
    let terminal = ops.terminal();
    if (!terminal)
        return !!saved && !ops.isVisible() && sameCore();
    if (terminal.pid !== shellPid || !["live", "finished"].includes(terminal.state))
        return false;
    const verifyLive = () => {
        if (!ops.owns())
            return false;
        const info = ops.foreground();
        if (info.shellPid !== shellPid) return false;
        if (options) return options.cancelPids.includes(shellPid) && info.foregroundProcesses.length > 0 && info.foregroundProcesses.every(process => options.cancelPids.includes(process.pid));
        return info.shellOwnsForeground && info.foregroundProcesses.length === 1 && info.foregroundProcesses[0].pid === shellPid;
    };
    if (terminal.state === "live" && !verifyLive())
        return false;
    if (!saved) {
        if (terminal.state !== "live" || !sameCore())
            return false;
        saved = { paneId, shellPid, coreId: core.id, corePid: core.pid, coreStart: core.start, bootId: core.bootId };
        ops.save(saved);
    }
    if (ops.isVisible()) {
        if (!sameCore())
            return false;
        ops.park();
        if (ops.isVisible())
            return false;
    }
    if (!sameCore())
        return false;
    terminal = ops.terminal();
    if (!terminal)
        return true;
    if (terminal.pid !== shellPid)
        return false;
    if (terminal.state === "live") {
        if (!verifyLive() || !sameCore())
            return false;
        ops.kill();
        if (!sameCore())
            return false;
        terminal = ops.terminal();
        if (!terminal)
            return true;
    }
    if (terminal.pid !== shellPid || terminal.state !== "finished" || !sameCore())
        return false;
    ops.remove();
    return sameCore() && !ops.terminal() && !ops.isVisible();
}
/** Bind retirement to the exact core connection captured from the parent session. */
export function appRetireOperations(context, paneId, owns, save) {
    return {
        coreIdentity() {
            const status = JSON.parse(runAppCore(context, ["server", "status", "--json"]));
            const identity = captureLaunchPaneOwnership("core", status.pid);
            return { id: status.core?.id, pid: status.pid, start: identity?.shellStart ?? "", bootId: identity?.bootId ?? "" };
        },
        terminal() {
            try {
                const value = JSON.parse(runAppCore(context, ["get", paneId]));
                if (value.address !== paneId || !Number.isSafeInteger(value.pid) || value.pid <= 0)
                    throw new Error("Invalid terminal identity.");
                return { state: value.state, pid: value.pid };
            }
            catch (error) {
                for (const raw of [error?.stdout, error?.stderr]) {
                    if (typeof raw !== "string")
                        continue;
                    try {
                        if (JSON.parse(raw)?.error?.kind === "not_found")
                            return undefined;
                    }
                    catch { /* not a structured response */ }
                }
                throw error;
            }
        },
        foreground: () => appProcessInfo(context, paneId),
        isVisible: () => appSpaces(context).some(space => space.tabs.some(tab => tab.terminals.some(pane => pane.terminal === paneId))),
        park: () => parkAppTerminal(context, paneId),
        kill: () => { runAppCore(context, ["kill", paneId]); },
        remove: () => { runAppCore(context, ["rm", paneId]); },
        owns, save,
    };
}
