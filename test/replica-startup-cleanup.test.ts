import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { launchPiSubagent, type PiLaunchOperations } from "../pi-extension/subagents/launch.ts";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it } from "node:test";
import { cleanupReplicaWork, readReplicaWork, replicaLaunchFailureReported, type ReplicaWork } from "../pi-extension/subagents/replica-work.ts";
import { seedSessionBinding, sessionBindingStore, writeBindingFile } from "../pi-extension/subagents/session-binding.ts";
import { discoverLineageRoots, reduceLineage } from "../pi-extension/subagents/lineage.ts";

function processStart(pid: number): string {
	const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
	return stat.slice(stat.lastIndexOf(")") + 2).split(/\s+/)[19];
}

function fixture() {
	const root = mkdtempSync(join(tmpdir(), "replica-startup-cleanup-"));
	const repo = join(root, "retained"), bin = join(root, "bin"), file = join(root, "attempt.json"), closed = join(root, "closed");
	mkdirSync(repo); mkdirSync(bin);
	writeFileSync(join(repo, "partial.txt"), "keep failed source\n");
	const launchPane = { paneId: "attempt-pane", shellPid: process.pid, shellStart: processStart(process.pid),
		bootId: readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim() };
	const state = { version: 1, id: "attempt", parentSessionId: "parent", fork: { commit: "base" }, joinBase: "base",
		worktree: { path: repo, branch: "replica/parent/attempt", workspaceId: "attempt-workspace", paneId: "attempt-pane", baseRef: "base", baseSha: "base", manifestFile: join(root, "manifest.json") },
		launchPane, completion: { name: "attempt", task: "work", summary: "", exitCode: 1, elapsed: 0, errorMessage: "Failed to load extension" },
		integration: { status: "not-attempted" } };
	writeBindingFile(file, state);
	const config = join(root, "config.json");
	writeBindingFile(config, { repo, shellPid: process.pid, extraPid: false });
	writeFileSync(join(bin, "herdr"), `#!/usr/bin/env node
const fs = require('node:fs');
const args = process.argv.slice(2), cfg = JSON.parse(fs.readFileSync(${JSON.stringify(config)}, 'utf8'));
let result;
if (args[0] === 'worktree' && args[1] === 'list') result = {type:'worktree_list',worktrees:[{path:cfg.repo,branch:'replica/parent/attempt',is_linked_worktree:true,...(!fs.existsSync(${JSON.stringify(closed)})?{open_workspace_id:'attempt-workspace'}:{})}]};
else if (args[0] === 'pane' && args[1] === 'list') result = {panes:[{pane_id:'attempt-pane'}]};
else if (args[0] === 'pane' && args[1] === 'process-info') result = {process_info:{pane_id:'attempt-pane',shell_pid:cfg.shellPid,foreground_processes:cfg.extraPid?[{pid:999999}]:[]}};
else if (args[0] === 'pane' && args[1] === 'get') result = {pane:{pane_id:'attempt-pane',tab_id:'attempt-tab'}};
else if (args[0] === 'tab' && args[1] === 'close' && args[2] === 'attempt-tab') {fs.appendFileSync(${JSON.stringify(closed)}, 'attempt-tab\\n');result={};}
else {process.stderr.write('Unexpected fake Herdr call: '+args.join(' '));process.exit(1);}
process.stdout.write(JSON.stringify({result}));
`, { mode: 0o700 });
	const oldPath = process.env.PATH;
	process.env.PATH = bin + ":" + oldPath;
	return { root, repo, file, closed, config, state, restore: () => { process.env.PATH = oldPath; rmSync(root, { recursive: true, force: true }); } };
}

it("closes a failed startup from launch ownership without a child session binding", { skip: process.platform !== "linux", timeout: 5000 }, () => {
	const f = fixture();
	try {
		assert.equal(readReplicaWork(f.file).worktreeLocation, undefined);
		assert.equal(cleanupReplicaWork(f.file, f.repo), true);
		assert.equal(readFileSync(f.closed, "utf8"), "attempt-tab\n");
		assert.equal(readFileSync(join(f.repo, "partial.txt"), "utf8"), "keep failed source\n");
		assert.equal(cleanupReplicaWork(f.file, f.repo), true);
		assert.equal(readFileSync(f.closed, "utf8"), "attempt-tab\n", "repeat evidence must not close another tab");
	} finally { f.restore(); }
});

for (const change of ["missing-owner", "other-boot", "reused-shell", "other-pane", "active-process", "not-failed"]) {
	it(`does not close a startup pane with ${change}`, { skip: process.platform !== "linux", timeout: 5000 }, () => {
		const f = fixture();
		try {
			const state: any = { ...f.state, launchPane: { ...f.state.launchPane } };
			if (change === "missing-owner") delete state.launchPane;
			if (change === "other-boot") state.launchPane.bootId = "another-boot";
			if (change === "reused-shell") state.launchPane.shellStart = "old-incarnation";
			if (change === "other-pane") state.launchPane.paneId = "another-pane";
			if (change === "not-failed") { delete state.completion; state.integration = { status: "pending" }; }
			if (change === "active-process") writeBindingFile(f.config, { repo: f.repo, shellPid: process.pid, extraPid: true });
			writeBindingFile(f.file, state);
			assert.equal(cleanupReplicaWork(f.file, f.repo), false);
			assert.equal(existsSync(f.closed), false);
		} finally { f.restore(); }
	});
}

for (const failure of ["shell-ready", "dispatch"]) {
	it(`closes an allocated replica pane when ${failure} fails before Pi starts`, { skip: process.platform !== "linux", timeout: 5000 }, async () => {
		const f = fixture();
		try {
			const git = (...args: string[]) => execFileSync("git", args, { cwd: f.repo, encoding: "utf8" }).trim();
			git("init", "-q"); git("config", "user.name", "Test"); git("config", "user.email", "test@example.invalid");
			git("add", "."); git("commit", "-qm", "base");
			const state: any = { ...f.state }; delete state.worktree; delete state.completion; delete state.launchPane;
			state.integration = { status: "pending" }; writeBindingFile(f.file, state);
			const parent = join(f.root, "parent.jsonl");
			writeFileSync(parent, JSON.stringify({ type: "session", version: 3, id: "parent", cwd: f.repo }) + "\n");
			const operations: PiLaunchOperations & { getPaneProcessInfo: () => any } = {
				createPane: () => { throw new Error("unexpected ordinary pane"); },
				createWorktree: () => ({ path: f.repo, branch: f.state.worktree.branch, workspaceId: "attempt-workspace", paneId: "attempt-pane" }),
				getPaneProcessInfo: () => ({ paneId: "attempt-pane", shellPid: process.pid, pids: [process.pid], foregroundProcesses: [] }),
				waitForShellReady: async () => { if (failure === "shell-ready") throw new Error("STARTUP_READY_FAILED"); },
				runScript: () => { throw new Error("STARTUP_DISPATCH_FAILED"); },
			};
			await assert.rejects(launchPiSubagent({
				kind: "fresh", id: "attempt", name: "attempt", task: "work", worktree: { branch: f.state.worktree.branch },
				parent: { cwd: f.repo, sessionFile: parent, sessionId: "parent", sessionDir: f.root, agentDir: join(f.root, "agent") },
				runtimePlan: { provider: "fake", modelId: "fake", model: "fake/fake", thinking: "off", modelSource: "parent", thinkingSource: "parent" },
				replication: { entries: [], contextMessages: [], systemPrompt: "test", extensionArgs: [], recordFile: f.file },
				behavior: { deniedTools: [], autoExit: true, interactive: false, sessionMode: "fork" },
			}, operations), /STARTUP_(READY|DISPATCH)_FAILED/);
			assert.equal(readFileSync(f.closed, "utf8"), "attempt-tab\n", "the allocated failed attempt must not leave a shell pane");
			assert.match(readReplicaWork(f.file).launchError!, /STARTUP_(READY|DISPATCH)_FAILED/);
			assert.equal(readFileSync(join(f.repo, "partial.txt"), "utf8"), "keep failed source\n");
		} finally { f.restore(); }
	});
}

it("keeps a replica recoverable when worktree allocation fails before a surface exists", { timeout: 5000 }, async () => {
	const f = fixture();
	try {
		const git = (...args: string[]) => execFileSync("git", args, { cwd: f.repo, encoding: "utf8" }).trim();
		git("init", "-q"); git("config", "user.name", "Test"); git("config", "user.email", "test@example.invalid");
		git("add", "."); git("commit", "-qm", "base");
		const state: any = { ...f.state }; delete state.worktree; delete state.completion; delete state.launchPane;
		state.integration = { status: "pending" }; writeBindingFile(f.file, state);
		const parent = join(f.root, "parent.jsonl");
		writeFileSync(parent, JSON.stringify({ type: "session", version: 3, id: "parent", cwd: f.repo }) + "\n");
		seedSessionBinding(parent, { version: 1, storeDir: sessionBindingStore(parent, join(f.root, "agent")) });
		const executionOwner = { toolCallId: "allocation-call", parentToolCallId: "outer-call" };
		const operations: PiLaunchOperations = {
			createPane: () => { throw new Error("unexpected ordinary pane"); },
			createWorktree: () => {
				const node = discoverLineageRoots(f.root, parent).map(root => reduceLineage(root).nodes.get("attempt")).find(Boolean);
				assert.equal(node?.replication, true, "allocation must start with recoverable replica identity");
				assert.equal(node.replicaWorkFile, f.file);
				assert.equal(node.name, "attempt");
				assert.equal(node.task, "work");
				assert.deepEqual(node.executionOwner, executionOwner);
				assert.ok(typeof node.startTime === "number" && node.startTime > 0);
				assert.equal(node.sessionFile, undefined);
				assert.equal(node.surface, undefined);
				throw new Error("STARTUP_ALLOCATION_FAILED");
			},
			waitForShellReady: async () => { throw new Error("unexpected readiness wait"); },
			runScript: () => { throw new Error("unexpected dispatch"); },
		};
		await assert.rejects(launchPiSubagent({
			kind: "fresh", id: "attempt", name: "attempt", task: "work", executionOwner, worktree: { branch: f.state.worktree.branch },
			parent: { cwd: f.repo, sessionFile: parent, sessionId: "parent", sessionDir: f.root, agentDir: join(f.root, "agent") },
			runtimePlan: { provider: "fake", modelId: "fake", model: "fake/fake", thinking: "off", modelSource: "parent", thinkingSource: "parent" },
			replication: { entries: [], contextMessages: [], systemPrompt: "test", extensionArgs: [], recordFile: f.file },
			behavior: { deniedTools: [], autoExit: true, interactive: false, sessionMode: "fork" },
		}, operations), /STARTUP_ALLOCATION_FAILED/);
		const saved = readReplicaWork(f.file);
		assert.match(saved.launchError!, /STARTUP_ALLOCATION_FAILED/);
		assert.equal(saved.worktree, undefined);
		assert.equal(saved.sessionFile, undefined);
		assert.equal(saved.integration.status, "not-attempted");
		assert.equal(existsSync(f.closed), false);
	} finally { f.restore(); }
});
it("acknowledges only the exact launch's persisted native error during replay", () => {
	const record = { launchError: "dispatch failed", launchErrorToolCallId: "failed-call" } as ReplicaWork;
	const entry = { type: "message", message: { role: "toolResult", toolCallId: "failed-call", isError: true } };
	assert.equal(replicaLaunchFailureReported(record, [entry]), true);
	assert.equal(replicaLaunchFailureReported(record, [{ ...entry, message: { ...entry.message, toolCallId: "another-call" } }]), false);
	assert.equal(replicaLaunchFailureReported(record, [{ ...entry, message: { ...entry.message, isError: false } }]), false);
	assert.equal(replicaLaunchFailureReported(record, [{ ...entry, type: "custom_message" }]), false);
	assert.equal(replicaLaunchFailureReported({ ...record, launchErrorToolCallId: undefined }, [entry]), false);
	assert.equal(replicaLaunchFailureReported({ ...record, launchErrorToolCallId: undefined }, [entry], { toolCallId: "failed-call", parentToolCallId: "root-call" }), true);
	const owner = { toolCallId: "failed-call", parentToolCallId: "root-call" };
	const outer = { ...entry, message: { ...entry.message, toolCallId: "root-call", content: [{ text: "Some other call failed" }] } };
	assert.equal(replicaLaunchFailureReported(record, [outer], owner), false);
	outer.message.content = [{ text: "Script failed: Error: dispatch failed" }];
	assert.equal(replicaLaunchFailureReported(record, [outer], owner), true);
});
