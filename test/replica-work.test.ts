import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it } from "node:test";
import { snapshotSource } from "../pi-extension/subagents/source-state.ts";
import { checkpointReplicaCompletion, createReplicaWork, joinReplicaWork, reserveReplicaContinuation, releaseReplicaContinuation, readReplicaWork } from "../pi-extension/subagents/replica-work.ts";
import { withLineageMutationGate } from "../pi-extension/subagents/lineage.ts";
import { writeBindingFile } from "../pi-extension/subagents/session-binding.ts";

function savedFailure() {
	const dir = mkdtempSync(join(tmpdir(), "replica-work-"));
	const repo = join(dir, "repo"), store = join(dir, "store"), file = join(store, "first.json"), session = join(dir, "session.jsonl");
	mkdirSync(repo); mkdirSync(store);
	const git = (...args: string[]) => execFileSync("git", args, { cwd: repo, encoding: "utf8" }).trim();
	git("init", "-q"); git("config", "user.name", "Test"); git("config", "user.email", "test@example.invalid");
	writeFileSync(join(repo, "source.txt"), "base\n"); git("add", "."); git("commit", "-qm", "base");
	const source = snapshotSource(repo, store);
	createReplicaWork(file, "first", "owner", source);
	writeFileSync(session, JSON.stringify({ type: "session", version: 3, id: "saved-session", cwd: repo }) + "\n");
	writeFileSync(join(repo, "source.txt"), "failed partial work\n");
	checkpointReplicaCompletion(file, repo, session, { name: "first", task: "work", summary: "", exitCode: 1, elapsed: 1, error: "test error" });
	return { repo, store, file, session, source, git, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

it("retains failed work and allows only its owner one saved-state continuation", () => {
	const { repo, store, file, session, source, git, cleanup } = savedFailure();
	try {
		writeFileSync(join(repo, "source.txt"), "parent later work\n");
		assert.equal(joinReplicaWork(file, repo).integration.status, "not-attempted");
		assert.equal(readFileSync(join(repo, "source.txt"), "utf8"), "parent later work\n");
		assert.throws(() => reserveReplicaContinuation(file, "stranger", "next"), /owned/);
		const previous = reserveReplicaContinuation(file, "owner", "next");
		assert.equal(git("show", `${previous.checkpoint!.commit}:source.txt`), "failed partial work");
		assert.equal(previous.joinBase, source.commit);
		assert.throws(() => reserveReplicaContinuation(file, "owner", "other"), /active/);
		createReplicaWork(join(store, "next.json"), "next", "owner", previous.checkpoint!, previous.joinBase);
		checkpointReplicaCompletion(join(store, "next.json"), repo, session, { name: "next", task: "continue", summary: "failed again", exitCode: 1, elapsed: 1 });
		assert.equal(reserveReplicaContinuation(file, "owner", "third").id, "next");
		assert.equal(readReplicaWork(join(store, "next.json")).continuationAttempt, "third");
	} finally { cleanup(); }
});

it("blocks a successful join into an unrelated repository without changing either source", () => {
	const child = savedFailure(), parent = savedFailure();
	try {
		const file = join(child.store, "successful.json");
		createReplicaWork(file, "successful", "owner", child.source);
		checkpointReplicaCompletion(file, child.repo, child.session, { name: "successful", task: "work", summary: "done", exitCode: 0, elapsed: 1 });
		const head = parent.git("rev-parse", "HEAD"), index = parent.git("ls-files", "--stage");
		const record = joinReplicaWork(file, parent.repo);
		assert.equal(record.integration.status, "blocked");
		assert.match(record.integration.details!, /different repository/);
		assert.equal(parent.git("rev-parse", "HEAD"), head);
		assert.equal(parent.git("ls-files", "--stage"), index);
		assert.equal(readFileSync(join(parent.repo, "source.txt"), "utf8"), "failed partial work\n");
		assert.equal(readFileSync(join(child.repo, "source.txt"), "utf8"), "failed partial work\n");
		assert.ok(record.checkpoint && record.sessionCheckpoint);
	} finally { child.cleanup(); parent.cleanup(); }
});
it("serializes continuation reservations and releases with the same filesystem gate", () => {
	const { file, cleanup } = savedFailure();
	try {
		withLineageMutationGate(file + ".artifacts", () => {
			assert.throws(() => reserveReplicaContinuation(file, "owner", "next"), /active mutation/);
		});
		reserveReplicaContinuation(file, "owner", "next");
		withLineageMutationGate(file + ".artifacts", () => {
			assert.throws(() => releaseReplicaContinuation(file, "next"), /active mutation/);
		});
		releaseReplicaContinuation(file, "different");
		assert.equal(readReplicaWork(file).continuationAttempt, "next");
		releaseReplicaContinuation(file, "next");
		assert.equal(readReplicaWork(file).continuationAttempt, undefined);
	} finally { cleanup(); }
});

it("reclaims an unpublished continuation only after its reserving process is gone", () => {
	const { file, cleanup } = savedFailure();
	try {
		reserveReplicaContinuation(file, "owner", "lost");
		assert.throws(() => reserveReplicaContinuation(file, "owner", "next"), /active/);
		const reserved = readReplicaWork(file);
		const { continuationOwner: _owner, ...unknown } = reserved;
		writeBindingFile(file, unknown);
		assert.throws(() => reserveReplicaContinuation(file, "owner", "next"), /active/);
		writeBindingFile(file, { ...reserved, continuationOwner: { pid: 0 } });
		assert.throws(() => reserveReplicaContinuation(file, "owner", "next"), /Invalid replica work/);
		writeBindingFile(file, reserved);
		const endedPid = Number(execFileSync(process.execPath, ["-e", "console.log(process.pid)"], { encoding: "utf8" }).trim());
		writeBindingFile(file, { ...readReplicaWork(file), continuationOwner: { pid: endedPid } });
		const previous = reserveReplicaContinuation(file, "owner", "next");
		assert.equal(previous.id, "first");
		assert.equal(readReplicaWork(file).continuationAttempt, "next");
		assert.equal(readReplicaWork(file).checkpoint?.commit, previous.checkpoint?.commit);
	} finally { cleanup(); }
});
