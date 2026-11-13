import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { checkpointReplicaCompletion, cleanupReplicaWork, joinReplicaWork, readReplicaWork } from "./replica-work.js";
import { materializeReplicationHistory } from "./replica-history.js";
import { childSessionLocation, parentSessionLocation, sessionLocationAlive, sessionOwnsPane, writeBindingFile } from "./session-binding.js";
import { getAppContext } from "./app-context.js";
import { appRetireOperations, retireAppTerminal } from "./app-retire.js";
import { closeHerdrSurface, getHerdrPaneProcessInfo } from "./herdr.js";
import { reduceLineage, withLineageMutationGate } from "./lineage.js";
function sameParent(file, expected) {
    const record = readReplicaWork(file);
    const current = parentSessionLocation(dirname(dirname(file)), record.parentSessionId);
    return !!current && current.sessionId === expected.sessionId && current.pid === expected.pid &&
        current.processStart === expected.processStart && current.cwd === expected.cwd &&
        current.sessionFile === expected.sessionFile && sessionLocationAlive(current);
}
/** Longest wait for a settled replica's Pi to finish shutting down. */
const REPLICA_EXIT_WAIT_MS = 10_000;
/**
 * The parent delivers a replica's result as soon as it is saved, while that
 * replica's Pi is still shutting down. Cleanup needs the exit; wait for it here,
 * outside the durable gate, so a normal shutdown does not become a refused
 * cleanup that only the slow backoff retry repeats.
 */
async function waitForReplicaExit(request) {
    if (request.operation !== "cleanup")
        return;
    const deadline = Date.now() + REPLICA_EXIT_WAIT_MS;
    for (;;) {
        let locations;
        try {
            locations = [readReplicaWork(request.file).worktreeLocation, request.child && childSessionLocation(request.child.rootDir, request.child.nodeId)];
        }
        catch {
            return;
        } // Cleanup itself reports an unreadable record.
        if (!locations.some(location => location && sessionLocationAlive(location)) || Date.now() >= deadline)
            return;
        await new Promise(resolve => setTimeout(resolve, 100));
    }
}
function execute(request) {
    return withLineageMutationGate(request.file + ".artifacts", () => {
        if (request.operation === "cleanup") {
            const record = readReplicaWork(request.file);
            const cancellation = request.child && reduceLineage(request.child.rootDir).nodes.get(request.child.nodeId)?.cancellation;
            if ((record.worktree?.paneId ?? record.sharedPane) && request.surface !== (record.worktree?.paneId ?? record.sharedPane) && request.child) {
                const location = childSessionLocation(request.child.rootDir, request.child.nodeId);
                if (location && sessionLocationAlive(location)) return { cleaned: false };
                if (record.backend === "app") {
                    const context = process.env.HERDR_ENV === "1" ? undefined : getAppContext();
                    const saved = record.appMovedRetirement ?? (cancellation?.proven && cancellation.app?.paneId === request.surface ? cancellation.app : undefined);
                    const shellPid = saved?.shellPid ?? location?.shellPid;
                    if (!context || !location || !shellPid || location.paneId !== request.surface) return { cleaned: false };
                    const ops = appRetireOperations(context, request.surface, () => sessionOwnsPane(location, request.surface, shellPid), value => {
                        writeBindingFile(request.file, { ...readReplicaWork(request.file), appMovedRetirement: value });
                    });
                    if (!retireAppTerminal(request.surface, shellPid, saved, ops)) return { cleaned: false };
                } else {
                    const info = getHerdrPaneProcessInfo(request.surface);
                    if (location && sessionOwnsPane(location, request.surface, info.shellPid)) {
                        closeHerdrSurface(request.surface);
                        return { cleaned: false };
                    }
                }
            }
            const original = record.worktree?.paneId ?? record.sharedPane;
            return { cleaned: cleanupReplicaWork(request.file, request.parentCwd, cancellation?.proven && cancellation.app?.paneId === original ? cancellation.app : undefined) };
        }
        const saved = readReplicaWork(request.file);
        const completion = { ...request.completion };
        const failed = completion.exitCode !== 0 || !!completion.error || !!completion.errorMessage || !completion.summary.trim();
        if (failed && !saved.completion) {
            try {
                completion.historyPath = materializeReplicationHistory(existsSync(request.sessionFile) ? request.sessionFile : saved.sessionCheckpoint ?? request.sessionFile, saved.id, completion.name);
            }
            catch (error) {
                // Missing history must not strand an otherwise reportable terminal failure.
                completion.historyError = String(error);
            }
        }
        let work = checkpointReplicaCompletion(request.file, request.cwd, request.sessionFile, completion);
        if (!failed && work.mode !== "shared" && request.parent && sameParent(request.file, request.parent)) {
            // Different Pi incarnations and siblings share this gate, not just an in-memory queue.
            work = withLineageMutationGate(join(dirname(request.file), "joins", encodeURIComponent(work.parentSessionId)), () => {
                if (!sameParent(request.file, request.parent))
                    return work;
                return joinReplicaWork(request.file, request.parent.cwd, () => sameParent(request.file, request.parent));
            });
        }
        const { runtime: _runtime, ...result } = work;
        return { work: result };
    });
}
process.once("message", async (request) => {
    let response;
    await waitForReplicaExit(request);
    for (;;) {
        try {
            response = { result: execute(request) };
            break;
        }
        catch (error) {
            if (!String(error).includes("Durable state has an active mutation.")) {
                response = { error: String(error) };
                break;
            }
            // Wait in this worker instead of starting fresh processes while another owner works.
            await new Promise((resolve) => setTimeout(resolve, 100));
        }
    }
    if (process.connected)
        process.send(response, () => process.disconnect?.());
});
