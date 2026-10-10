import assert from "node:assert/strict";
import { execFileSync, fork, spawn } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it } from "node:test";
import { runReplicaBackground } from "../pi-extension/subagents/replica-background.ts";
import { createReplicaWork, readReplicaWork } from "../pi-extension/subagents/replica-work.ts";
import { snapshotSource } from "../pi-extension/subagents/source-state.ts";
import { processIncarnationAlive } from "../pi-extension/subagents/lineage.ts";

it("does not keep durable ownership alive for a zombie PID", { skip: process.platform !== "linux", timeout: 5000 }, async () => {
	const owner = spawn("python3", ["-c", "import os,sys\npid=os.fork()\nif pid==0: os._exit(0)\nprint(pid,flush=True)\nsys.stdin.read()\nos.waitpid(pid,0)"], { stdio: ["pipe", "pipe", "pipe"] });
	const exited = new Promise<void>(resolve => owner.once("exit", () => resolve()));
	try {
		const pid = await new Promise<number>((resolve, reject) => {
			owner.stdout.once("data", data => resolve(Number(String(data).trim())));
			owner.once("error", reject);
		});
		const deadline = Date.now() + 2000;
		while (!readFileSync(`/proc/${pid}/stat`, "utf8").split(") ")[1].startsWith("Z ")) {
			assert.ok(Date.now() < deadline, "owned child must become a zombie before inspection");
			await new Promise(resolve => setTimeout(resolve, 10));
		}
		assert.equal(processIncarnationAlive({ pid }, { pid: process.pid }), false);
	} finally { owner.stdin.end(); await exited; }
});

it("waits without blocking and recovers a completion gate after its owner dies", { timeout: 10_000 }, async () => {
	const directory = mkdtempSync(join(tmpdir(), "replica-background-"));
	const repo = join(directory, "repo"), store = join(directory, "store");
	mkdirSync(repo); mkdirSync(store);
	const git = (...args: string[]) => execFileSync("git", args, { cwd: repo, encoding: "utf8" }).trim();
	git("init", "-q"); git("config", "user.name", "Test"); git("config", "user.email", "test@example.invalid");
	writeFileSync(join(repo, "source.txt"), "base\n"); git("add", "."); git("commit", "-qm", "base");
	const file = join(store, "attempt.json"), session = join(directory, "session.jsonl");
	createReplicaWork(file, "attempt", "parent", snapshotSource(repo, store));
	writeFileSync(session, JSON.stringify({ type: "session", version: 3, id: "child", cwd: repo }) + "\n");
	writeFileSync(join(repo, "source.txt"), "child work\n");
	const module = new URL("../pi-extension/subagents/lineage.js", import.meta.url).href;
	const holder = spawn(process.execPath, ["--input-type=module", "-e", `import {withLineageMutationGate} from ${JSON.stringify(module)}; withLineageMutationGate(${JSON.stringify(file + ".artifacts")},()=>{process.stdout.write('owned\\n');Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0);});`], { stdio: ["ignore", "pipe", "pipe"] });
	const exited = new Promise<void>((resolve) => holder.once("exit", () => resolve()));
	let timer: ReturnType<typeof setInterval> | undefined;
	let pending: ReturnType<typeof runReplicaBackground> | undefined;
	try {
		await new Promise<void>((resolve, reject) => {
			holder.stdout.once("data", () => resolve());
			holder.once("error", reject);
			holder.once("exit", () => reject(new Error("Gate owner exited before publishing ownership.")));
		});
		let ticks = 0, completed = false;
		timer = setInterval(() => ticks++, 10);
		pending = runReplicaBackground({ operation: "complete", file, cwd: repo, sessionFile: session, completion: { name: "attempt", task: "work", summary: "done", exitCode: 0, elapsed: 1 } });
		void pending.then(() => { completed = true; }, () => {});
		await new Promise((resolve) => setTimeout(resolve, 200));
		assert.ok(ticks > 0, "the caller must remain responsive while another process owns completion");
		assert.equal(completed, false);
		assert.equal(readReplicaWork(file).completion, undefined);
		holder.kill("SIGKILL"); await exited;
		const { work } = await pending;
		assert.equal(work?.completion?.summary, "done");
		assert.equal(work?.integration.status, "pending", "a closed parent must not be opened or joined automatically");
		assert.equal(git("show", `${work!.checkpoint!.commit}:source.txt`), "child work");
		assert.equal(readReplicaWork(file).checkpoint?.commit, work?.checkpoint?.commit);
	} finally {
		if (timer) clearInterval(timer);
		holder.kill("SIGKILL"); await exited;
		if (pending) await pending.catch(() => {});
		rmSync(directory, { recursive: true, force: true });
	}
});

it("recovers the saved attempt after its background worker dies during checkpoint", { timeout: 10_000 }, async () => {
	const directory = mkdtempSync(join(tmpdir(), "replica-interrupted-"));
	const repo = join(directory, "repo"), store = join(directory, "store"), bin = join(directory, "bin");
	mkdirSync(repo); mkdirSync(store); mkdirSync(bin);
	const realGit = execFileSync("which", ["git"], { encoding: "utf8" }).trim();
	const git = (...args: string[]) => execFileSync(realGit, args, { cwd: repo, encoding: "utf8" }).trim();
	git("init", "-q"); git("config", "user.name", "Test"); git("config", "user.email", "test@example.invalid");
	writeFileSync(join(repo, "source.txt"), "base\n"); git("add", "."); git("commit", "-qm", "base");
	const file = join(store, "attempt.json"), session = join(directory, "session.jsonl");
	createReplicaWork(file, "attempt", "parent", snapshotSource(repo, store));
	writeFileSync(session, JSON.stringify({ type: "session", version: 3, id: "child", cwd: repo }) + "\n");
	writeFileSync(join(repo, "source.txt"), "recoverable work\n");
	const started = join(directory, "started"), release = join(directory, "release"), finished = join(directory, "finished");
	writeFileSync(join(bin, "git"), `#!/bin/bash
if test ! -f '${started}'; then
 touch '${started}'
 for ((i=0;i<100;i++)); do test -f '${release}' && break; sleep 0.02; done
fi
'${realGit}' "$@"
status=$?
touch '${finished}'
exit "$status"
`, { mode: 0o700 });
	const request = { operation: "complete" as const, file, cwd: repo, sessionFile: session,
		completion: { name: "attempt", task: "work", summary: "recovered summary", exitCode: 0, elapsed: 1 } };
	const worker = fork(new URL("../pi-extension/subagents/replica-worker.js", import.meta.url), [], {
		execArgv: [], env: { ...process.env, PATH: bin + ":" + process.env.PATH }, stdio: ["ignore", "ignore", "ignore", "ipc"],
	});
	const exited = new Promise<void>((resolve) => worker.once("exit", () => resolve()));
	const waitFor = async (check: () => boolean) => {
		const deadline = Date.now() + 3000;
		while (!check()) { assert.ok(Date.now() < deadline, "owned checkpoint operation must settle"); await new Promise(resolve => setTimeout(resolve, 10)); }
	};
	try {
		worker.send(request);
		await waitFor(() => existsSync(started));
		assert.equal(readReplicaWork(file).completion, undefined);
		worker.kill("SIGKILL"); await exited;
		writeFileSync(release, "go");
		await waitFor(() => existsSync(finished));
		const { work } = await runReplicaBackground(request);
		assert.equal(work?.completion?.summary, request.completion.summary);
		assert.equal(work?.integration.status, "pending");
		assert.equal(git("show", `${work!.checkpoint!.commit}:source.txt`), "recoverable work");
		const again = await runReplicaBackground(request);
		assert.equal(again.work?.checkpoint?.commit, work?.checkpoint?.commit, "recovery must keep the settled checkpoint");
	} finally {
		worker.kill("SIGKILL"); await exited;
		writeFileSync(release, "go");
		await waitFor(() => existsSync(finished));
		rmSync(directory, { recursive: true, force: true });
	}
});
