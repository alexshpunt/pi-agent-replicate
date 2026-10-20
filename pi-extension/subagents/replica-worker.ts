import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { checkpointReplicaCompletion, cleanupReplicaWork, joinReplicaWork, readReplicaWork } from "./replica-work.ts";
import { materializeReplicationHistory } from "./replica-history.ts";
import { childSessionLocation, parentSessionLocation, sessionLocationAlive, sessionOwnsPane, type SessionLocation } from "./session-binding.ts";
import { closeHerdrSurface, getHerdrPaneProcessInfo } from "./herdr.ts";
import { withLineageMutationGate } from "./lineage.ts";
import type { ReplicaBackgroundRequest, ReplicaBackgroundResult } from "./replica-background.ts";

function sameParent(file: string, expected: SessionLocation): boolean {
	const record = readReplicaWork(file);
	const current = parentSessionLocation(dirname(dirname(file)), record.parentSessionId);
	return !!current && current.sessionId === expected.sessionId && current.pid === expected.pid &&
		current.processStart === expected.processStart && current.cwd === expected.cwd &&
		current.sessionFile === expected.sessionFile && sessionLocationAlive(current);
}

function execute(request: ReplicaBackgroundRequest): ReplicaBackgroundResult {
	return withLineageMutationGate(request.file + ".artifacts", () => {
		if (request.operation === "cleanup") {
			const record = readReplicaWork(request.file);
			if (record.worktree && request.surface !== record.worktree.paneId && request.child) {
				const location = childSessionLocation(request.child.rootDir, request.child.nodeId);
				if (location && sessionLocationAlive(location)) return { cleaned: false };
				const info = getHerdrPaneProcessInfo(request.surface);
				if (location && sessionOwnsPane(location, request.surface, info.shellPid)) {
					closeHerdrSurface(request.surface);
					return { cleaned: false };
				}
			}
			return { cleaned: cleanupReplicaWork(request.file, request.parentCwd) };
		}
		const saved = readReplicaWork(request.file);
		const completion = { ...request.completion };
		const failed = completion.exitCode !== 0 || !!completion.error || !!completion.errorMessage || !completion.summary.trim();
		if (failed && !saved.completion) {
			try {
				completion.historyPath = materializeReplicationHistory(
					existsSync(request.sessionFile) ? request.sessionFile : saved.sessionCheckpoint ?? request.sessionFile, saved.id, completion.name);
			} catch (error) {
				// Missing history must not strand an otherwise reportable terminal failure.
				completion.historyError = String(error);
			}
		}
		let work = checkpointReplicaCompletion(request.file, request.cwd, request.sessionFile, completion);
		if (!failed && request.parent && sameParent(request.file, request.parent)) {
			// Different Pi incarnations and siblings share this gate, not just an in-memory queue.
			work = withLineageMutationGate(join(dirname(request.file), "joins", encodeURIComponent(work.parentSessionId)), () => {
				if (!sameParent(request.file, request.parent!)) return work;
				return joinReplicaWork(request.file, request.parent!.cwd, () => sameParent(request.file, request.parent!));
			});
		}
		const { runtime: _runtime, ...result } = work;
		return { work: result };
	});
}

process.once("message", async (request: ReplicaBackgroundRequest) => {
	let response: { result?: ReplicaBackgroundResult; error?: string };
	for (;;) {
		try { response = { result: execute(request) }; break; }
		catch (error) {
			if (!String(error).includes("Durable state has an active mutation.")) {
				response = { error: String(error) }; break;
			}
			// Wait in this worker instead of starting fresh processes while another owner works.
			await new Promise((resolve) => setTimeout(resolve, 100));
		}
	}
	if (process.connected) process.send!(response, () => process.disconnect?.());
});
