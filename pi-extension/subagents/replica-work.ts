import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, readlinkSync, readdirSync, realpathSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { dirname, join } from "node:path";
import { writeBindingFile, readSessionBinding, childSessionLocation, sessionLocationAlive, sessionOwnsPane, launchOwnsPane, type SessionLocation, type LaunchPaneOwnership } from "./session-binding.ts";
import { closeHerdrSurface, getHerdrPaneProcessInfo, listHerdrWorktrees } from "./herdr.ts";
import { applySourceJoin, planSourceJoin, snapshotSource, type SourceJoinReady, type SourceSnapshot } from "./source-state.ts";
import type { WorktreeLaunch } from "./launch.ts";
import { processIncarnationAlive, withLineageMutationGate, type ProcessIncarnation } from "./lineage.ts";

/** Durable terminal task facts, separate from the later integration outcome. */
export interface ReplicaCompletion {
	name: string;
	task: string;
	summary: string;
	exitCode: number;
	elapsed: number;
	error?: string;
	errorMessage?: string;
	historyPath?: string;
	/** Why post-fork answers could not be safely exported; never blocks settlement. */
	historyError?: string;
}

/** One owned attempt. Its source/session checkpoint survives worktree cleanup. */
export interface ReplicaWork {
	version: 1;
	id: string;
	parentSessionId: string;
	fork: SourceSnapshot;
	/** Original fork basis for outstanding work, or the last already-integrated checkpoint. */
	joinBase: string;
	worktree?: WorktreeLaunch;
	sessionFile?: string;
	/** Durable JSONL copy outside the disposable checkout. */
	sessionCheckpoint?: string;
	/** Session-copy failure; source work is still checkpointed and retained. */
	sessionCheckpointError?: string;
	worktreeLocation?: SessionLocation;
	/** Original allocated shell, recorded by the parent before running Pi. */
	launchPane?: LaunchPaneOwnership;
	checkpoint?: SourceSnapshot;
	checkpointError?: string;
	completion?: ReplicaCompletion;
	joinPlan?: SourceJoinReady;
	integration: { status: "pending" | "applied" | "conflict" | "blocked" | "not-attempted"; details?: string };
	cleaned?: boolean;
	/** The next attempt in this continuation; completed chains resolve to their latest state. */
	continuationAttempt?: string;
	/** Owner of an unpublished next attempt; only a proven dead process can release it. */
	continuationOwner?: ProcessIncarnation;
	launchError?: string;
	/** Exact failing invocation, for replay acknowledgement of its native tool error. */
	launchErrorToolCallId?: string;
	/** Saved inherited runtime, independent of the requesting parent's current configuration. */
	runtime?: { systemPrompt: string; extensionArgs: string[]; provider: string; modelId: string; thinking: string; tools: string[] };
}

/** Resolve an attempt only inside the session's durable binding store. */
export function replicaWorkFile(storeDir: string, id: string): string {
	if (!/^[a-zA-Z0-9-]+$/.test(id)) throw new Error("Invalid replica continuation ID.");
	return join(storeDir, "replicas", `${id}.json`);
}

/** Load known ownership; missing or malformed records are never guessed recoverable. */
export function readReplicaWork(file: string): ReplicaWork {
	const value = JSON.parse(readFileSync(file, "utf8")) as ReplicaWork;
	if (value.version !== 1 || !value.id || !value.parentSessionId || !value.fork?.commit || !value.joinBase || !value.integration ||
		(value.continuationOwner && (!Number.isInteger(value.continuationOwner.pid) || value.continuationOwner.pid <= 0 || (value.continuationOwner.startTime != null && typeof value.continuationOwner.startTime !== "string")))) throw new Error("Invalid replica work record.");
	return value;
}

/** Record the source basis before Herdr allocates any resources. */
export function createReplicaWork(file: string, id: string, parentSessionId: string, fork: SourceSnapshot, joinBase = fork.commit): void {
	if (existsSync(file)) throw new Error("Replica work identity already exists.");
	writeBindingFile(file, { version: 1, id, parentSessionId, fork, joinBase, integration: { status: "pending" } } satisfies ReplicaWork);
}

/** Reserve the latest settled attempt for its exact immediate parent. */
export function reserveReplicaContinuation(file: string, parentSessionId: string, attemptId: string): ReplicaWork {
	let current = file;
	const seen = new Set<string>();
	for (;;) {
		const result = withLineageMutationGate(current + ".artifacts", (owner): { record: ReplicaWork } | { next: string } => {
			const record = readReplicaWork(current);
			if (record.parentSessionId !== parentSessionId) throw new Error("Continuation is not owned by this session.");
			if (seen.has(record.id)) throw new Error("Invalid continuation cycle.");
			seen.add(record.id);
			if (!record.completion && !record.launchError) throw new Error("Continuation is still active.");
			if (record.integration.status === "pending") throw new Error("Continuation has an active integration.");
			const binding = record.sessionFile && existsSync(record.sessionFile) ? readSessionBinding(record.sessionFile) : undefined;
			const location = binding?.child ? childSessionLocation(binding.child.lineage.rootDir, binding.child.lineage.nodeId) : record.worktreeLocation;
			if (location && sessionLocationAlive(location)) throw new Error("Continuation session is still active.");
			if (record.continuationAttempt) {
				const next = join(dirname(current), record.continuationAttempt + ".json");
				if (!existsSync(next)) {
					if (!record.continuationOwner || processIncarnationAlive(record.continuationOwner, owner)) throw new Error("Continuation has an active launch reservation.");
				} else {
					const child = readReplicaWork(next);
					if (!child.completion && !child.launchError) throw new Error("Continuation is still active.");
					if (!child.launchError) return { next };
				}
			}
			if (!record.checkpoint || !record.sessionCheckpoint) throw new Error("Continuation has no usable saved source/session checkpoint.");
			writeBindingFile(current, { ...record, continuationAttempt: attemptId, continuationOwner: owner });
			return { record };
		});
		if ("record" in result) return result.record;
		current = result.next;
	}
}

/** Release only this unpublished launch; never clear another attempt's reservation. */
export function releaseReplicaContinuation(file: string, attemptId: string): void {
	withLineageMutationGate(file + ".artifacts", () => {
		const record = readReplicaWork(file);
		if (record.continuationAttempt !== attemptId) return;
		const { continuationAttempt: _attempt, continuationOwner: _owner, ...rest } = record;
		writeBindingFile(file, rest);
	});
}
/** Persist runtime before launch, so recovery never silently adopts another configuration. */
export function saveReplicaRuntime(file: string, runtime: NonNullable<ReplicaWork["runtime"]>): void {
	writeBindingFile(file, { ...readReplicaWork(file), runtime });
}

/** Preserve failed allocation facts and release a reservation without discarding evidence. */
export function failReplicaLaunch(file: string, error: unknown, toolCallId?: string): void {
	writeBindingFile(file, { ...readReplicaWork(file), launchError: String(error), ...(toolCallId ? { launchErrorToolCallId: toolCallId } : {}), integration: { status: "not-attempted", details: "Launch failed; saved work was not applied." } });
}

/** A persisted native tool error already delivered this pre-acknowledgement failure. */
export function replicaLaunchFailureReported(record: ReplicaWork, entries: readonly unknown[], owner?: { toolCallId: string; parentToolCallId: string }): boolean {
	if (!record.launchError) return false;
	const ids = new Set([record.launchErrorToolCallId, owner?.toolCallId].filter(Boolean));
	const diagnostic = record.launchError.replace(/^(?:Error:\s*)+/, "");
	return entries.some(entry => {
		const row = entry as { type?: string; message?: { role?: string; toolCallId?: string; isError?: boolean; content?: { text?: string }[] } } | undefined;
		const message = row?.message;
		if (row?.type !== "message" || message?.role !== "toolResult" || message.isError !== true) return false;
		if (ids.has(message.toolCallId)) return true;
		// An outer script may fail for another call. Require this launch's actual facts.
		return !!owner?.parentToolCallId && message.toolCallId === owner.parentToolCallId && !!diagnostic && Array.isArray(message.content) &&
			message.content.some(block => typeof block.text === "string" &&
				(block.text.includes(diagnostic) || block.text.includes(JSON.stringify(diagnostic).slice(1, -1))));
	});
}
/** Bind allocated worktree and session before the child process can start. */
export function attachReplicaWork(file: string, worktree: WorktreeLaunch, sessionFile?: string): void {
	const record = readReplicaWork(file);
	writeBindingFile(file, { ...record, worktree, ...(sessionFile ? { sessionFile } : {}) });
}

/** Save launch ownership before the child can fail during extension loading. */
export function captureReplicaLaunchPane(file: string, owner: LaunchPaneOwnership): void {
	const record = readReplicaWork(file);
	if (!record.worktree || record.worktree.paneId !== owner.paneId) throw new Error("Launch ownership does not match the replica pane.");
	if (record.launchPane) {
		if (!launchOwnsPane(record.launchPane, owner.paneId, owner.shellPid)) throw new Error("Replica launch shell incarnation changed.");
		return;
	}
	writeBindingFile(file, { ...record, launchPane: owner });
}

/** Preserve the launch workspace's process incarnation even if the session later teleports. */
export function captureReplicaWorkLocation(file: string, location: SessionLocation): void {
	const record = readReplicaWork(file);
	if (record.worktreeLocation || !record.worktree || location.paneId !== record.worktree.paneId) return;
	if (realpathSync(location.cwd) !== realpathSync(record.worktree.path)) return;
	writeBindingFile(file, { ...record, worktreeLocation: location });
}

/** Save task result and latest files before join or pane/worktree cleanup. */
export function checkpointReplicaCompletion(file: string, cwd: string, sessionFile: string, completion: ReplicaCompletion): ReplicaWork {
	let record = readReplicaWork(file);
	if (record.completion) return record;
	const sessionDir = file + ".artifacts";
	mkdirSync(sessionDir, { recursive: true });
	const sessionCheckpoint = join(sessionDir, "session.jsonl");
	try {
		writeFileSync(sessionCheckpoint, readFileSync(sessionFile), { mode: 0o600 });
		for (const path of [sessionCheckpoint, sessionDir]) {
			const fd = openSync(path, "r");
			try { fsyncSync(fd); } finally { closeSync(fd); }
		}
		record = { ...record, sessionCheckpoint };
	} catch (error) {
		record = { ...record, sessionCheckpointError: String(error) };
	}
	try {
		const checkpoint = snapshotSource(cwd, join(file + ".artifacts", "source"));
		if (checkpoint.commonDir !== record.fork.commonDir) throw new Error("Replica moved outside its source repository.");
		record = { ...record, checkpoint };
	} catch (error) {
		record = { ...record, checkpointError: String(error) };
	}
	const failed = completion.exitCode !== 0 || !!completion.error || !!completion.errorMessage || !completion.summary.trim();
	record = { ...record, sessionFile, completion, integration: failed
		? { status: "not-attempted", details: "The task failed; partial work was not applied." }
		: record.sessionCheckpointError
			? { status: "blocked", details: `The session could not be saved: ${record.sessionCheckpointError}` }
			: record.integration };
	writeBindingFile(file, record);
	return record;
}

/** Attempt successful work; the optional receiver check can refuse application after a session move. */
export function joinReplicaWork(file: string, parentCwd: string, parentActive: () => boolean = () => true): ReplicaWork {
	let record = readReplicaWork(file);
	if (!record.completion) throw new Error("Replica has no saved task result.");
	if (record.integration.status !== "pending") return record;
	if (!record.checkpoint) {
		record = { ...record, integration: { status: "blocked", details: record.checkpointError ?? "No saved source checkpoint." } };
		writeBindingFile(file, record); return record;
	}
	try {
		const parent = snapshotSource(parentCwd, join(file + ".artifacts", "parent"));
		if (parent.commonDir !== record.fork.commonDir) throw new Error("The parent is now in a different repository; saved work was not applied there.");
		if (record.joinPlan && record.joinPlan.before.repoDir !== parent.repoDir) throw new Error("An interrupted join belongs to another parent checkout; its saved plan is retained.");
		if (!record.joinPlan) {
			const plan = planSourceJoin(parent.repoDir, record.joinBase, record.checkpoint.commit, join(file + ".artifacts", "join"));
			if (plan.status === "conflict") {
				record = { ...record, integration: { status: "conflict", details: plan.details } };
				writeBindingFile(file, record); return record;
			}
			record = { ...record, joinPlan: plan };
			writeBindingFile(file, record);
		}
		applySourceJoin(record.joinPlan!, () => {
			if (!parentActive()) throw new Error("The parent session moved or closed during integration; saved work was retained.");
		});
		record = { ...record, integration: { status: "applied" } };
	} catch (error) {
		record = { ...record, integration: { status: "blocked", details: String(error) } };
	}
	writeBindingFile(file, record);
	return record;
}

/** Close an owned settled pane; remove its checkout only after safe integration. */
export function cleanupReplicaWork(file: string, parentCwd: string): boolean {
	const record = readReplicaWork(file), worktree = record.worktree;
	if (record.cleaned || !worktree) return true;
	const removeWorktree = record.integration.status === "applied";
	const matches = listHerdrWorktrees(parentCwd).filter((entry) => entry.path === worktree.path && entry.branch === worktree.branch && entry.isLinkedWorktree);
	if (matches.length > 1) throw new Error("Ambiguous replica worktree ownership.");
	if (!matches.length) {
		if (!removeWorktree) return true;
		if (existsSync(worktree.path)) return false;
		writeBindingFile(file, { ...record, cleaned: true });
		return true;
	}
	const observed = matches[0];
	if (record.worktreeLocation && sessionLocationAlive(record.worktreeLocation)) return false;
	if (removeWorktree) {
		if (!record.checkpoint || !record.sessionCheckpoint || !existsSync(record.sessionCheckpoint)) return false;
		const checkpoint = snapshotSource(worktree.path, join(file + ".artifacts", "cleanup"));
		if (checkpoint.tree !== record.checkpoint.tree || checkpoint.head !== record.checkpoint.head || checkpoint.indexHash !== record.checkpoint.indexHash) return false; // Never discard edits made after settlement.
	}
	if (observed.workspaceId) {
		if (observed.workspaceId !== worktree.workspaceId) return false;
		const failedLaunch = !record.worktreeLocation && !!record.launchPane &&
			(!!record.launchError || (record.completion != null && record.completion.exitCode !== 0));
		if (!record.worktreeLocation && !failedLaunch) return false;
		const response = JSON.parse(execFileSync("herdr", ["pane", "list", "--workspace", observed.workspaceId], { encoding: "utf8" }));
		const panes = response?.result?.panes;
		if (!Array.isArray(panes) || panes.length !== 1 || panes[0].pane_id !== worktree.paneId) return false;
		const info = getHerdrPaneProcessInfo(worktree.paneId);
		const owned = record.worktreeLocation
			? sessionOwnsPane(record.worktreeLocation, worktree.paneId, info.shellPid)
			: launchOwnsPane(record.launchPane!, worktree.paneId, info.shellPid);
		if (!owned || info.pids.some((pid) => pid !== info.shellPid)) return false;
		if (!removeWorktree) {
			closeHerdrSurface(worktree.paneId);
			return true;
		}
		execFileSync("herdr", ["worktree", "remove", "--workspace", observed.workspaceId, "--force", "--trust-repository"], { encoding: "utf8" });
	} else {
		if (!removeWorktree) return true;
		// A restarted Herdr may no longer have its workspace. Keep any surviving cwd users.
		for (const pid of readdirSync("/proc").filter((entry) => /^\d+$/.test(entry))) {
			let cwd: string;
			try { cwd = readlinkSync(`/proc/${pid}/cwd`); } catch { continue; }
			if (cwd === worktree.path || cwd === `${worktree.path} (deleted)` || cwd.startsWith(worktree.path + "/")) return false;
		}
		execFileSync("git", ["worktree", "remove", "--force", worktree.path], { cwd: parentCwd, encoding: "utf8" });
	}
	if (existsSync(worktree.path)) throw new Error("Replica worktree cleanup could not be verified.");
	writeBindingFile(file, { ...record, cleaned: true });
	return true;
}
