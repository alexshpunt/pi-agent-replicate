import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, readlinkSync, readdirSync, realpathSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { dirname, join } from "node:path";
import { writeBindingFile, readSessionBinding, childSessionLocation, sessionLocationAlive, sessionOwnsPane } from "./session-binding.js";
import { getHerdrPaneProcessInfo, listHerdrWorktrees } from "./herdr.js";
import { applySourceJoin, planSourceJoin, snapshotSource } from "./source-state.js";
import { processIncarnationAlive, withLineageMutationGate } from "./lineage.js";
/** Resolve an attempt only inside the session's durable binding store. */
export function replicaWorkFile(storeDir, id) {
    if (!/^[a-zA-Z0-9-]+$/.test(id))
        throw new Error("Invalid replica continuation ID.");
    return join(storeDir, "replicas", `${id}.json`);
}
/** Load known ownership; missing or malformed records are never guessed recoverable. */
export function readReplicaWork(file) {
    const value = JSON.parse(readFileSync(file, "utf8"));
    if (value.version !== 1 || !value.id || !value.parentSessionId || !value.fork?.commit || !value.joinBase || !value.integration ||
        (value.continuationOwner && (!Number.isInteger(value.continuationOwner.pid) || value.continuationOwner.pid <= 0 || (value.continuationOwner.startTime != null && typeof value.continuationOwner.startTime !== "string"))))
        throw new Error("Invalid replica work record.");
    return value;
}
/** Record the source basis before Herdr allocates any resources. */
export function createReplicaWork(file, id, parentSessionId, fork, joinBase = fork.commit) {
    if (existsSync(file))
        throw new Error("Replica work identity already exists.");
    writeBindingFile(file, { version: 1, id, parentSessionId, fork, joinBase, integration: { status: "pending" } });
}
/** Reserve the latest settled attempt for its exact immediate parent. */
export function reserveReplicaContinuation(file, parentSessionId, attemptId) {
    let current = file;
    const seen = new Set();
    for (;;) {
        const result = withLineageMutationGate(current + ".artifacts", (owner) => {
            const record = readReplicaWork(current);
            if (record.parentSessionId !== parentSessionId)
                throw new Error("Continuation is not owned by this session.");
            if (seen.has(record.id))
                throw new Error("Invalid continuation cycle.");
            seen.add(record.id);
            if (!record.completion && !record.launchError)
                throw new Error("Continuation is still active.");
            if (record.integration.status === "pending")
                throw new Error("Continuation has an active integration.");
            const binding = record.sessionFile && existsSync(record.sessionFile) ? readSessionBinding(record.sessionFile) : undefined;
            const location = binding?.child ? childSessionLocation(binding.child.lineage.rootDir, binding.child.lineage.nodeId) : record.worktreeLocation;
            if (location && sessionLocationAlive(location))
                throw new Error("Continuation session is still active.");
            if (record.continuationAttempt) {
                const next = join(dirname(current), record.continuationAttempt + ".json");
                if (!existsSync(next)) {
                    if (!record.continuationOwner || processIncarnationAlive(record.continuationOwner, owner))
                        throw new Error("Continuation has an active launch reservation.");
                }
                else {
                    const child = readReplicaWork(next);
                    if (!child.completion && !child.launchError)
                        throw new Error("Continuation is still active.");
                    if (!child.launchError)
                        return { next };
                }
            }
            if (!record.checkpoint || !record.sessionCheckpoint)
                throw new Error("Continuation has no usable saved source/session checkpoint.");
            writeBindingFile(current, { ...record, continuationAttempt: attemptId, continuationOwner: owner });
            return { record };
        });
        if ("record" in result)
            return result.record;
        current = result.next;
    }
}
/** Release only this unpublished launch; never clear another attempt's reservation. */
export function releaseReplicaContinuation(file, attemptId) {
    withLineageMutationGate(file + ".artifacts", () => {
        const record = readReplicaWork(file);
        if (record.continuationAttempt !== attemptId)
            return;
        const { continuationAttempt: _attempt, continuationOwner: _owner, ...rest } = record;
        writeBindingFile(file, rest);
    });
}
/** Persist runtime before launch, so recovery never silently adopts another configuration. */
export function saveReplicaRuntime(file, runtime) {
    writeBindingFile(file, { ...readReplicaWork(file), runtime });
}
/** Preserve failed allocation facts and release a reservation without discarding evidence. */
export function failReplicaLaunch(file, error) {
    writeBindingFile(file, { ...readReplicaWork(file), launchError: String(error), integration: { status: "not-attempted", details: "Launch failed; saved work was not applied." } });
}
/** Bind allocated worktree and session before the child process can start. */
export function attachReplicaWork(file, worktree, sessionFile) {
    const record = readReplicaWork(file);
    writeBindingFile(file, { ...record, worktree, sessionFile });
}
/** Preserve the launch workspace's process incarnation even if the session later teleports. */
export function captureReplicaWorkLocation(file, location) {
    const record = readReplicaWork(file);
    if (record.worktreeLocation || !record.worktree || location.paneId !== record.worktree.paneId)
        return;
    if (realpathSync(location.cwd) !== realpathSync(record.worktree.path))
        return;
    writeBindingFile(file, { ...record, worktreeLocation: location });
}
/** Save task result and latest files before join or pane/worktree cleanup. */
export function checkpointReplicaCompletion(file, cwd, sessionFile, completion) {
    let record = readReplicaWork(file);
    if (record.completion)
        return record;
    const sessionDir = file + ".artifacts";
    mkdirSync(sessionDir, { recursive: true });
    const sessionCheckpoint = join(sessionDir, "session.jsonl");
    writeFileSync(sessionCheckpoint, readFileSync(sessionFile), { mode: 0o600 });
    for (const path of [sessionCheckpoint, sessionDir]) {
        const fd = openSync(path, "r");
        try {
            fsyncSync(fd);
        }
        finally {
            closeSync(fd);
        }
    }
    record = { ...record, sessionCheckpoint };
    try {
        const checkpoint = snapshotSource(cwd, join(file + ".artifacts", "source"));
        if (checkpoint.commonDir !== record.fork.commonDir)
            throw new Error("Replica moved outside its source repository.");
        record = { ...record, checkpoint };
    }
    catch (error) {
        record = { ...record, checkpointError: String(error) };
    }
    const failed = completion.exitCode !== 0 || !!completion.error || !!completion.errorMessage || !completion.summary.trim();
    record = { ...record, sessionFile, completion, integration: failed ? { status: "not-attempted", details: "The task failed; partial work was not applied." } : record.integration };
    writeBindingFile(file, record);
    return record;
}
/** Attempt successful work; the optional receiver check can refuse application after a session move. */
export function joinReplicaWork(file, parentCwd, parentActive = () => true) {
    let record = readReplicaWork(file);
    if (!record.completion)
        throw new Error("Replica has no saved task result.");
    if (record.integration.status !== "pending")
        return record;
    if (!record.checkpoint) {
        record = { ...record, integration: { status: "blocked", details: record.checkpointError ?? "No saved source checkpoint." } };
        writeBindingFile(file, record);
        return record;
    }
    try {
        const parent = snapshotSource(parentCwd, join(file + ".artifacts", "parent"));
        if (parent.commonDir !== record.fork.commonDir)
            throw new Error("The parent is now in a different repository; saved work was not applied there.");
        if (record.joinPlan && record.joinPlan.before.repoDir !== parent.repoDir)
            throw new Error("An interrupted join belongs to another parent checkout; its saved plan is retained.");
        if (!record.joinPlan) {
            const plan = planSourceJoin(parent.repoDir, record.joinBase, record.checkpoint.commit, join(file + ".artifacts", "join"));
            if (plan.status === "conflict") {
                record = { ...record, integration: { status: "conflict", details: plan.details } };
                writeBindingFile(file, record);
                return record;
            }
            record = { ...record, joinPlan: plan };
            writeBindingFile(file, record);
        }
        applySourceJoin(record.joinPlan, () => {
            if (!parentActive())
                throw new Error("The parent session moved or closed during integration; saved work was retained.");
        });
        record = { ...record, integration: { status: "applied" } };
    }
    catch (error) {
        record = { ...record, integration: { status: "blocked", details: String(error) } };
    }
    writeBindingFile(file, record);
    return record;
}
/** Remove only unchanged, integrated, session-backed work owned by this attempt. */
export function cleanupReplicaWork(file, parentCwd) {
    const record = readReplicaWork(file), worktree = record.worktree;
    if (record.cleaned || !worktree)
        return true;
    if (record.integration.status !== "applied")
        return true; // Failure/conflict intentionally retains its workspace.
    if (!record.checkpoint || !record.sessionCheckpoint || !existsSync(record.sessionCheckpoint))
        return false;
    const matches = listHerdrWorktrees(parentCwd).filter((entry) => entry.path === worktree.path && entry.branch === worktree.branch && entry.isLinkedWorktree);
    if (matches.length > 1)
        throw new Error("Ambiguous replica worktree ownership.");
    if (!matches.length) {
        if (existsSync(worktree.path))
            return false;
        writeBindingFile(file, { ...record, cleaned: true });
        return true;
    }
    const observed = matches[0];
    if (record.worktreeLocation && sessionLocationAlive(record.worktreeLocation))
        return false;
    const checkpoint = snapshotSource(worktree.path, join(file + ".artifacts", "cleanup"));
    if (checkpoint.tree !== record.checkpoint.tree || checkpoint.head !== record.checkpoint.head || checkpoint.indexHash !== record.checkpoint.indexHash)
        return false; // Never discard edits made after settlement.
    if (observed.workspaceId) {
        if (observed.workspaceId !== worktree.workspaceId || !record.worktreeLocation)
            return false;
        const response = JSON.parse(execFileSync("herdr", ["pane", "list", "--workspace", observed.workspaceId], { encoding: "utf8" }));
        const panes = response?.result?.panes;
        if (!Array.isArray(panes) || panes.length !== 1 || panes[0].pane_id !== worktree.paneId)
            return false;
        const info = getHerdrPaneProcessInfo(worktree.paneId);
        if (!sessionOwnsPane(record.worktreeLocation, worktree.paneId, info.shellPid) || info.pids.some((pid) => pid !== info.shellPid))
            return false;
        execFileSync("herdr", ["worktree", "remove", "--workspace", observed.workspaceId, "--force", "--trust-repository"], { encoding: "utf8" });
    }
    else {
        // A restarted Herdr may no longer have its workspace. Keep any surviving cwd users.
        for (const pid of readdirSync("/proc").filter((entry) => /^\d+$/.test(entry))) {
            let cwd;
            try {
                cwd = readlinkSync(`/proc/${pid}/cwd`);
            }
            catch {
                continue;
            }
            if (cwd === worktree.path || cwd === `${worktree.path} (deleted)` || cwd.startsWith(worktree.path + "/"))
                return false;
        }
        execFileSync("git", ["worktree", "remove", "--force", worktree.path], { cwd: parentCwd, encoding: "utf8" });
    }
    if (existsSync(worktree.path))
        throw new Error("Replica worktree cleanup could not be verified.");
    writeBindingFile(file, { ...record, cleaned: true });
    return true;
}
/** Report work problems and disclose a saved copy without host bookkeeping. */
export function replicaWorkReport(record) {
    if (record.integration.status === "applied") {
        return record.checkpoint && record.sessionCheckpoint ? `Saved copy: ${JSON.stringify(record.id)}. You can continue it with replicate using continuation and mode.` : "";
    }
    const problem = record.integration.status === "conflict"
        ? "The copy finished, but its changes conflict with your current work and were not included."
        : record.integration.status === "not-attempted"
            ? "The copy's unfinished work was not included in your work."
            : "The copy finished, but its changes could not be safely included in your work.";
    if (!record.checkpoint || !record.sessionCheckpoint) {
        return `${problem}\nNo usable saved continuation is available.${record.worktree ? ` The copy's files remain at ${record.worktree.path}.` : ""}`;
    }
    return [
        problem,
        "Its work is saved. To continue it alongside your own independent work, use replicate with:",
        `continuation: ${JSON.stringify(record.id)}, mode: "resume", task: "The exact work to finish and expected result".`,
        "Use mode: \"fork\" to start a new copy from where it stopped instead.",
    ].join("\n");
}
