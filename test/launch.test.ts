import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import {
	launchPiSubagent,
	type FreshPiLaunchRequest,
	type PiLaunchOperations,
	type ResumePiLaunchRequest,
} from "../pi-extension/subagents/launch.ts";

import { registerLineage, reduceLineage } from "../pi-extension/subagents/lineage.ts";
import { seedSessionBinding } from "../pi-extension/subagents/session-binding.ts";

function fixture() {
	const root = mkdtempSync(join(tmpdir(), "subagent-launch-test-"));
	const project = join(root, "project");
	const agentDir = join(root, "agent");
	const sessionDir = join(root, "parent-sessions");
	const parentSessionFile = join(sessionDir, "parent.jsonl");
	mkdirSync(project, { recursive: true });
	mkdirSync(sessionDir, { recursive: true });
	writeFileSync(
		parentSessionFile,
		`${JSON.stringify({ type: "session", version: 3, id: "parent", cwd: project })}\n`,
	);

	seedSessionBinding(parentSessionFile, { version: 1, storeDir: join(agentDir, "subagent-sessions") });
	const request: FreshPiLaunchRequest = {
		kind: "fresh",
		id: "child-1",
		name: "Worker",
		task: "Implement the bounded change.",
		agent: "worker",
		parent: {
			cwd: project,
			sessionFile: parentSessionFile,
			sessionId: "parent",
			sessionDir,
			agentDir,
		},
		runtimePlan: {
			provider: "fake",
			modelId: "worker",
			model: "fake/worker",
			thinking: "high",
			modelSource: "agent",
			thinkingSource: "agent",
		},
		behavior: {
			tools: "read,bash",
			skills: "tdd",
			deniedTools: ["subagent", "subagent_resume"],
			autoExit: true,
			interactive: false,
			identity: "You are a focused worker.",
			systemPromptMode: "append",
			sessionMode: "standalone",
		},
	};
	return { root, project, agentDir, sessionDir, parentSessionFile, request };
}

function withFixture(
	run: (value: ReturnType<typeof fixture>) => Promise<void> | void,
) {
	const value = fixture();
	return Promise.resolve(run(value)).finally(() => {
		rmSync(value.root, { recursive: true, force: true });
	});
}

describe("Pi launch", () => {
	it("launches an ordinary child through one transaction", async () => {
		await withFixture(async ({ request, project, agentDir }) => {
			const projectAgentDir = join(project, ".pi", "agent");
			mkdirSync(projectAgentDir, { recursive: true });
			const events: string[] = [];
			let command = "";
			let scriptPath = "";
			const operations: PiLaunchOperations = {
				createPane(name) {
					assert.equal(name, "Worker");
					events.push("create");
					return "pane-1";
				},
				createWorktree() {
					throw new Error("unexpected worktree creation");
				},
				async waitForShellReady(surface) {
					assert.equal(surface, "pane-1");
					events.push("ready");
				},
				runScript(surface, value, options) {
					assert.equal(surface, "pane-1");
					events.push("run");
					command = value;
					scriptPath = options.scriptPath;
					return options.scriptPath;
				},
			};

			request.executionOwner = { toolCallId: "nested-leaf", parentToolCallId: "visible-root" };
			const running = await launchPiSubagent(request, operations);

			assert.deepEqual(events, ["create", "ready", "run"]);
			assert.equal(running.id, "child-1");
			assert.deepEqual(running.executionOwner, request.executionOwner);
			assert.deepEqual(reduceLineage(running.lineage!.rootDir).nodes.get(running.id)?.executionOwner, request.executionOwner);
			assert.equal(running.surface, "pane-1");
			assert.equal(running.launchScriptFile, scriptPath);
			assert.ok(running.sessionFile.startsWith(join(agentDir, "sessions")));
			assert.equal(command.includes(projectAgentDir), false);
			assert.match(command, new RegExp(`^cd '${project}' && `));
			assert.match(command, /PI_SUBAGENT_LAUNCHER_PID=\$\$/);
			assert.match(command, /--model 'fake\/worker'/);
			assert.match(command, /--thinking 'high'/);
			assert.match(command, /--tools 'read,bash,caller_ping'/);
			assert.doesNotMatch(command, /subagent_done/);
			assert.match(command, /PI_DENY_TOOLS='subagent,subagent_resume'/);
			assert.match(command, /PI_SUBAGENT_AUTO_EXIT=1/);
			assert.match(command, /PI_SUBAGENT_SKILLS='tdd'/);
			assert.doesNotMatch(command, /\/skill:/);
			assert.match(command, /'@[^']+\.md'; echo '__SUBAGENT_DONE_'/);

			const taskPath = command.match(/'@([^']+\.md)'/)?.[1];
			assert.ok(taskPath, "expected artifact-backed task delivery");
			assert.match(
				readFileSync(taskPath, "utf8"),
				/Complete your task autonomously\.[\s\S]*Implement the bounded change\./,
			);
			const systemPromptPath = command.match(
				/--append-system-prompt '([^']+\.md)'/,
			)?.[1];
			assert.ok(systemPromptPath, "expected system prompt artifact");
			assert.equal(
				readFileSync(systemPromptPath, "utf8"),
				"You are a focused worker.",
			);
		});
	});

	it("publishes recovery metadata before waiting on a newly allocated shell", async () => {
		await withFixture(async ({ request, root }) => {
			const lineage = registerLineage({ artifactDir: root, nodeId: request.id!, parentSessionId: "parent", launchKind: "fresh" });
			let started = false, closed = false;
			await assert.rejects(() => launchPiSubagent({ ...request, lineage }, {
				createPane: () => "pending-shell",
				createWorktree: () => { throw new Error("unexpected worktree"); },
				async waitForShellReady() {
					const node = reduceLineage(lineage.rootDir).nodes.get(request.id!)!;
					assert.equal(node.surface, "pending-shell");
					assert.ok(node.activityFile && node.settledEventsFile);
					assert.equal(JSON.parse(readFileSync(node.sessionFile!, "utf8").split("\n")[0]).cwd, request.parent.cwd);
					throw new Error("owned shell setup failed");
				},
				runScript: (_surface, _command, options) => { started = true; return options.scriptPath; },
				closePane: () => { closed = true; },
			}), /owned shell setup failed/);
			assert.equal(started, false);
			assert.equal(closed, true);
		});
	});
	it("clears inherited auto-exit state for interactive children", async () => {
		await withFixture(async ({ request }) => {
			let command = "";
			await launchPiSubagent(
				{
					...request,
					behavior: {
						...request.behavior,
						autoExit: false,
						interactive: true,
					},
				},
				{
					createPane: () => "pane-interactive",
					createWorktree: () => {
						throw new Error("unexpected worktree creation");
					},
					waitForShellReady: async () => {},
					runScript: (_surface, value, options) => {
						command = value;
						return options.scriptPath;
					},
				},
			);

			assert.match(command, /PI_SUBAGENT_AUTO_EXIT=0/);
			assert.match(command, /--tools 'read,bash,caller_ping,subagent_done'/);
		});
	});

	it("resumes a session through the launch transaction", async () => {
		await withFixture(async ({ root, sessionDir, parentSessionFile }) => {
			const sessionFile = join(root, "child.jsonl");
			writeFileSync(sessionFile, JSON.stringify({ type: "session", version: 3, id: "resume-session", cwd: root }) + "\n");
			const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
			process.env.PI_CODING_AGENT_DIR = join(root, "isolated-agent");
			try {
				const events: string[] = [];
				let command = "";
				let scriptPath = "";
				let scriptPreamble = "";
				const request: ResumePiLaunchRequest = {
					kind: "resume",
					id: "resume-1",
					name: "Resume worker",
					sessionFile,
					message: "Use the approved schema.",
					parent: { sessionId: "parent", sessionFile: parentSessionFile, sessionDir },
				};
				const operations: PiLaunchOperations = {
					createPane(name) {
						assert.equal(name, "Resume worker");
						events.push("create");
						return "pane-resume";
					},
					createWorktree() {
						throw new Error("a resume must not create a worktree");
					},
					async waitForShellReady(surface) {
						assert.equal(surface, "pane-resume");
						events.push("ready");
					},
					runScript(surface, value, options) {
						assert.equal(surface, "pane-resume");
						events.push("run");
						command = value;
						scriptPath = options.scriptPath;
						scriptPreamble = options.scriptPreamble;
						return options.scriptPath;
					},
				};

				const running = await launchPiSubagent(request, operations);

				assert.deepEqual(events, ["create", "ready", "run"]);
				assert.equal(running.id, "resume-1");
				assert.equal(running.name, "Resume worker");
				assert.equal(running.task, "Use the approved schema.");
				assert.equal(running.surface, "pane-resume");
				assert.equal(running.sessionFile, sessionFile);
				assert.equal(running.launchScriptFile, scriptPath);
				assert.equal(running.interactive, false);
				assert.equal(running.runtimePlan, undefined);
				assert.equal(running.worktree, undefined);
				assert.match(
					command,
					new RegExp(
						`^PI_CODING_AGENT_DIR='${process.env.PI_CODING_AGENT_DIR}' `,
					),
				);
				assert.match(command, new RegExp(`pi --session '${sessionFile}' -e `));
				assert.match(command, /PI_SUBAGENT_NAME='Resume worker'/);
				assert.match(
					command,
					new RegExp(`PI_SUBAGENT_SESSION='${sessionFile}'`),
				);
				assert.match(command, /PI_SUBAGENT_ID='resume-1'/);
				assert.match(command, /PI_SUBAGENT_LAUNCHER_PID=\$\$/);
				assert.match(command, /PI_SUBAGENT_ACTIVITY_FILE='/);
				assert.match(command, /PI_SUBAGENT_AUTO_EXIT=1/);
				assert.doesNotMatch(command, /--model|--thinking|^cd /);
				const messagePath = command.match(/'@([^']+\.md)'/)?.[1];
				assert.ok(messagePath, "expected artifact-backed follow-up message");
				assert.equal(
					readFileSync(messagePath, "utf8"),
					"Use the approved schema.",
				);
				assert.match(
					scriptPreamble,
					/# Subagent resume script for Resume worker/,
				);
				assert.match(
					scriptPreamble,
					new RegExp(`# Resume message file: ${messagePath}`),
				);
			} finally {
				if (previousAgentDir === undefined)
					delete process.env.PI_CODING_AGENT_DIR;
				else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
			}
		});
	});

	it("closes a replacement pane when resume setup fails before metadata", async () => {
		await withFixture(async ({ root, sessionDir, parentSessionFile }) => {
			const sessionFile = join(root, "failed-resume.jsonl");
			writeFileSync(sessionFile, JSON.stringify({ type: "session", version: 3, id: "resume-session", cwd: root }) + "\n");
			const events: string[] = [];

			await assert.rejects(
				launchPiSubagent(
					{
						kind: "resume",
						id: "failed-resume",
						name: "Failed resume",
						sessionFile,
						parent: {
							sessionId: "parent",
							sessionFile: parentSessionFile,
							sessionDir,
						},
					},
					{
						createPane() {
							events.push("create");
							return "pane-failed-resume";
						},
						createWorktree: () => {
							throw new Error("unexpected worktree creation");
						},
						async waitForShellReady() {
							events.push("ready");
							throw new Error("shell never became ready");
						},
						closePane(surface) {
							assert.equal(surface, "pane-failed-resume");
							events.push("close");
						},
						runScript() {
							throw new Error("script must not start");
						},
					},
				),
				/shell never became ready/,
			);

			assert.deepEqual(events, ["create", "ready", "close"]);
		});
	});

	it("keeps the durable child identity and can reuse its pane during recovery", async () => {
		await withFixture(async ({ root, sessionDir, parentSessionFile }) => {
			const sessionFile = join(root, "recovered.jsonl");
			writeFileSync(sessionFile, JSON.stringify({ type: "session", version: 3, id: "resume-session", cwd: root }) + "\n");
			const lineage = registerLineage({
				artifactDir: join(root, "artifacts"),
				nodeId: "durable-child",
				parentSessionId: "parent",
				parentSessionFile,
				launchKind: "fresh",
			});
			writeFileSync(`${sessionFile}.lineage.json`, JSON.stringify(lineage), "utf8");
			let created = false;
			let command = "";
			const running = await launchPiSubagent({
				kind: "resume",
				id: "transient-recovery-id",
				name: "Recovered worker",
				sessionFile,
				surface: "pane-existing",
				parent: { sessionId: "parent", sessionFile: parentSessionFile, sessionDir },
			}, {
				createPane: () => {
					created = true;
					return "unexpected";
				},
				createWorktree: () => { throw new Error("unexpected worktree creation"); },
				waitForShellReady: async (surface) => assert.equal(surface, "pane-existing"),
				runScript: (surface, value, options) => {
					assert.equal(surface, "pane-existing");
					command = value;
					return options.scriptPath;
				},
			});

			assert.equal(created, false);
			assert.equal(running.id, "durable-child");
			assert.equal(running.lineage?.nodeId, "durable-child");
			assert.match(command, /PI_SUBAGENT_ID='durable-child'/);
		});
	});

	it("clears inherited auto-exit state when a resumed session is interactive", async () => {
		await withFixture(async ({ root, sessionDir, parentSessionFile }) => {
			const sessionFile = join(root, "interactive.jsonl");
			writeFileSync(sessionFile, JSON.stringify({ type: "session", version: 3, id: "resume-session", cwd: root }) + "\n");
			const previousAutoExit = process.env.PI_SUBAGENT_AUTO_EXIT;
			process.env.PI_SUBAGENT_AUTO_EXIT = "1";
			try {
				let command = "";
				const running = await launchPiSubagent(
					{
						kind: "resume",
						id: "resume-interactive",
						name: "Interactive resume",
						sessionFile,
						parent: { sessionId: "parent", sessionFile: parentSessionFile, sessionDir },
						behavior: { autoExit: false },
					},
					{
						createPane: () => "pane-interactive",
						createWorktree: () => {
							throw new Error("a resume must not create a worktree");
						},
						waitForShellReady: async () => {},
						runScript: (_surface, value, options) => {
							command = value;
							return options.scriptPath;
						},
					},
				);

				assert.equal(running.task, "resumed session");
				assert.equal(running.interactive, true);
				assert.match(command, /PI_SUBAGENT_AUTO_EXIT=0/);
				assert.doesNotMatch(command, /'@[^']+\.md'/);
			} finally {
				if (previousAutoExit === undefined) delete process.env.PI_SUBAGENT_AUTO_EXIT;
				else process.env.PI_SUBAGENT_AUTO_EXIT = previousAutoExit;
			}
		});
	});

	it("records worktree ownership before creation and targets its root pane", async () => {
		await withFixture(async ({ request, project, sessionDir, root }) => {
			execFileSync("git", ["init", "-q"], { cwd: project });
			execFileSync("git", ["config", "user.email", "test@example.com"], {
				cwd: project,
			});
			execFileSync("git", ["config", "user.name", "Test"], { cwd: project });
			writeFileSync(join(project, "base.txt"), "base\n");
			execFileSync("git", ["add", "base.txt"], { cwd: project });
			execFileSync("git", ["commit", "-qm", "base"], { cwd: project });
			const baseSha = execFileSync("git", ["rev-parse", "HEAD"], {
				cwd: project,
				encoding: "utf8",
			}).trim();
			const worktreePath = join(root, "worker-tree");
			const worktreeRequest: FreshPiLaunchRequest = {
				...request,
				worktree: { branch: "issue/7", base: "HEAD" },
			};
			const manifestFile = join(
				sessionDir,
				"artifacts",
				"parent",
				"worktree-runs",
				"child-1.json",
			);
			const events: string[] = [];
			let command = "";
			const operations: PiLaunchOperations = {
				createPane() {
					throw new Error("unexpected pane creation");
				},
				createWorktree(name, cwd, branch, base) {
					assert.equal(name, "Worker");
					assert.equal(cwd, project);
					assert.equal(branch, "issue/7");
					assert.equal(base, baseSha);
					assert.equal(
						JSON.parse(readFileSync(manifestFile, "utf8")).state,
						"provisioning",
					);
					events.push("create");
					execFileSync(
						"git",
						["worktree", "add", "-q", "-b", branch, worktreePath, base],
						{
							cwd: project,
						},
					);
					return {
						path: worktreePath,
						branch,
						workspaceId: "workspace-1",
						paneId: "root-pane-1",
					};
				},
				async waitForShellReady(surface) {
					assert.equal(surface, "root-pane-1");
					events.push("ready");
				},
				runScript(surface, value, options) {
					assert.equal(surface, "root-pane-1");
					events.push("run");
					command = value;
					return options.scriptPath;
				},
			};

			const running = await launchPiSubagent(worktreeRequest, operations);

			assert.deepEqual(events, ["create", "ready", "run"]);
			assert.equal(running.worktree?.baseSha, baseSha);
			assert.equal(running.worktree?.path, worktreePath);
			assert.equal(running.worktree?.sessionFile, running.sessionFile);
			assert.match(command, new RegExp(`^cd '${worktreePath}' && `));
			const manifest = JSON.parse(readFileSync(manifestFile, "utf8"));
			assert.equal(manifest.state, "running");
			assert.equal(manifest.owner, "pi-herdr-subagents");
			assert.equal(manifest.paneId, "root-pane-1");
		});
	});

});
