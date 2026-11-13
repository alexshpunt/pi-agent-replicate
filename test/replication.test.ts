import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { it } from "node:test";
import { buildSessionContext } from "@earendil-works/pi-coding-agent";
import { seedReplicationSessionFile } from "../pi-extension/subagents/session.ts";
import { seedSessionBinding } from "../pi-extension/subagents/session-binding.ts";
import { materializeReplicationHistory, registerReplicateTool, replicationAssignment, replicationName, replicaWorkReport } from "../pi-extension/subagents/replication.ts";
import { getHerdrCurrentPaneTitle } from "../pi-extension/subagents/herdr.ts";
import subagentsExtension from "../pi-extension/subagents/index.ts";
import subagentDoneExtension from "../pi-extension/subagents/subagent-done.ts";

it("restores the exact inherited prompt after other extension hooks", () => {
	const dir = mkdtempSync(join(tmpdir(), "replica-prompt-"));
	try {
		const session = join(dir, "child.jsonl"), prompt = join(dir, "prompt.txt");
		writeFileSync(session, JSON.stringify({ type: "session", id: "clone", version: 3, cwd: dir }) + "\n");
		writeFileSync(prompt, "PARENT SYSTEM PROMPT\nCUSTOM CAPABILITY");
		seedSessionBinding(session, { version: 1, storeDir: join(dir, "store"), child: { lineage: { rootDir: join(dir, "lineage"), rootId: "root", nodeId: "clone", launchKind: "fork" }, environment: { PI_SUBAGENT_REPLICATION: "1", PI_SUBAGENT_REPLICATION_PROMPT_FILE: prompt } } });
		const handlers = new Map<string, Function[]>();
		const pi = { on: (name: string, fn: Function) => { handlers.set(name, [...(handlers.get(name) ?? []), fn]); } };
		subagentDoneExtension(pi as any);
		const hook = handlers.get("before_agent_start")?.at(-1);
		assert.ok(hook);
		const context = { sessionManager: { getSessionFile: () => session, getSessionId: () => "clone" } };
		assert.deepEqual(hook({ systemPrompt: "PARENT SYSTEM PROMPT\nCUSTOM CAPABILITY\nCUSTOM CAPABILITY" }, context), { systemPrompt: "PARENT SYSTEM PROMPT\nCUSTOM CAPABILITY" });
		assert.equal(hook({}, { sessionManager: { getSessionFile: () => session, getSessionId: () => "foreign" } }), undefined);
	} finally { rmSync(dir, { recursive: true, force: true }); }
});

it("reads the current pane name without falling back to another pane", () => {
	assert.equal(getHerdrCurrentPaneTitle((args) => {
		assert.deepEqual(args, ["pane", "current", "--current"]);
		return JSON.stringify({ result: { pane: { title: "Проверка панели" } } });
	}), "Проверка панели");
	assert.equal(getHerdrCurrentPaneTitle(() => JSON.stringify({ result: { pane: { label: "Проверка панели" } } })), "Проверка панели");
	assert.equal(getHerdrCurrentPaneTitle(() => "{}"), undefined);
	assert.equal(getHerdrCurrentPaneTitle(() => { throw new Error("Herdr unavailable"); }), undefined);
});

it("adds the origin from the session, then pane, then project", () => {
	let sessionName: string | undefined = "  Настройки  ";
	const pi = { getSessionName: () => sessionName };
	const ctx = { cwd: "/work/settings" };
	assert.equal(replicationName("check-tests", pi as any, ctx as any, () => { throw new Error("session has priority"); }), "check-tests ← Настройки");
	sessionName = " \n ";
	assert.equal(replicationName("check-tests", pi as any, ctx as any, () => "Проверка\nпанели"), "check-tests ← Проверка панели");
	assert.equal(replicationName("check-tests", pi as any, ctx as any, () => undefined), "check-tests ← settings");
});

it("keeps the supplied task name without automatic numbering", () => {
	const pi = { getSessionName: () => "check-owner ← Settings" };
	const ctx = { cwd: "/work/settings" };
	for (const name of ["check-tests", "check-tests", "check-types"]) {
		assert.equal(replicationName(name, pi as any, ctx as any, () => undefined), `${name} ← check-owner ← Settings`);
	}
});

it("saves the copy name without changing inherited session entries", () => {
	const dir = mkdtempSync(join(tmpdir(), "replication-name-"));
	try {
		const child = join(dir, "child.jsonl");
		const branch = [{ type: "session_info", id: "parent-name", name: "Настройки" }];
		seedReplicationSessionFile({ parentSessionFile: join(dir, "parent.jsonl"), childSessionFile: child, childCwd: dir, entries: branch, contextMessages: [], name: "check-tests ← Настройки" });
		const rows = readFileSync(child, "utf8").trim().split("\n").map((line) => JSON.parse(line));
		assert.deepEqual(rows.filter((row) => row.type === "session_info").map((row) => row.name), ["Настройки", "check-tests ← Настройки"]);
		assert.equal(rows.at(-1).parentId, "parent-name");
		assert.equal(branch[0].name, "Настройки");
	} finally { rmSync(dir, { recursive: true, force: true }); }
});
it("registers only the fresh replication tool", () => {
	const registered: string[] = [];
	subagentsExtension({
		registerTool: (tool: { name: string }) => registered.push(tool.name),
		registerCommand: () => {},
		on: () => () => {},
		registerMessageRenderer: () => {},
	} as any);
	assert.deepEqual(registered, ["replicate"]);
});
function toolSurface() {
	let definition: any;
	const handlers = new Map<string, Function>();
	const pi = { registerTool: (tool: any) => { definition = tool; }, on: (event: string, handler: Function) => { handlers.set(event, handler); } };
	const launches: any[] = [];
	registerReplicateTool(pi as any, async (params) => {
		launches.push(params);
		return { id: "copy", name: params.name, sessionFile: "/saved" };
	});
	const context = (id: string, branch: any[] = []): any => ({ sessionManager: { getSessionId: () => id, getBranch: () => branch } });
	return { handlers, context, launches, definition: () => definition };
}

it("keeps name and task as its only parameters after delivered results and session changes", () => {
	const surface = toolSurface();
	const branch = [{ type: "custom_message", customType: "subagent_result", details: { replication: true, recoveryAvailable: true, receiverSessionId: "original" } }];
	for (const id of ["original", "fresh-copy", "unrelated"]) {
		surface.handlers.get("session_start")?.({}, surface.context(id, branch));
		assert.deepEqual(Object.keys(surface.definition().parameters.properties), ["name", "task"]);
		assert.deepEqual(surface.definition().parameters.required, ["name", "task"]);
		assert.equal(surface.definition().parameters.additionalProperties, false);
		assert.equal(surface.definition().name, "replicate");
	}
});

it("asks the original for parallel blocks with separate areas and keeps commits with it", () => {
	const guidelines = toolSurface().definition().promptGuidelines.join("\n");
	assert.match(guidelines, /substantial, self-contained block[^\n]*needs no result from another block/);
	assert.match(guidelines, /Give each copy that changes files its own area[^\n]*name it in the task/);
	assert.match(guidelines, /If your next action after launching a copy would be to wait for it, do the work yourself instead\./);
	assert.match(guidelines, /Do not commit while copies run\. After they return, check the combined result and commit it yourself\./);
});

it("rejects missing or non-kebab-case names before launching", async () => {
	const surface = toolSurface(), ctx = surface.context("original");
	for (const name of [undefined, "", "Check-tests", "check tests", "check_tests", "check--tests", "-check", "check-", "проверка", "check\nname", "check\n", "check\r\n"]) {
		await assert.rejects(surface.definition().execute("call", { name, task: "review" }, undefined, undefined, ctx), /kebab-case name/);
	}
	assert.equal(surface.launches.length, 0);
});

it("names where a launched copy works", async () => {
	let tool: any;
	const children = [
		{ id: "a", name: "isolated", sessionFile: "/a", worktreePath: "/repo-worktrees/isolated", branch: "replica/origin/isolated" },
		{ id: "b", name: "shared", sessionFile: "/b" },
	];
	registerReplicateTool({ registerTool: (value: any) => { tool = value; }, on() {} } as any, async () => children.shift()!);
	const ctx: any = { cwd: "/repo", sessionManager: { getSessionId: () => "parent" } };
	const isolated = await tool.execute("one", { name: "isolated", task: "work" }, undefined, undefined, ctx);
	assert.equal(isolated.content[0].text, "isolated started in its own worktree /repo-worktrees/isolated on branch replica/origin/isolated. Its result will arrive here automatically; when it succeeds, its changes are applied to your working directory.");
	const shared = await tool.execute("two", { name: "shared", task: "work" }, undefined, undefined, ctx);
	assert.equal(shared.content[0].text, "shared started in your directory /repo. Its result will arrive here automatically.");
});

it("tells an isolated copy that its uncommitted changes join the original automatically", () => {
	assert.match(replicationAssignment("Fix the parser.", "worktree"), /your changes, committed or not, are applied to the original agent's working directory automatically; do not copy them there yourself\.\n[^\n]+\n\nYour assignment:\nFix the parser\.$/);
	const shared = replicationAssignment("Fix the parser.", "shared");
	assert.match(shared, /You work in the original agent's directory, and it sees your changes immediately\. Other copies may change other parts of it at the same time\./);
	assert.doesNotMatch(shared, /applied to the original/);
});

it("keeps a shared copy inside its area and away from Git", () => {
	const shared = replicationAssignment("Fix the parser.", "shared");
	assert.match(shared, /Change only the files your assignment covers\. Do not fix, revert or reformat changes outside it/);
	assert.match(shared, /Do not commit or change Git state[^\n]*The original agent commits the combined result; this overrides any instruction to commit your work\./);
	assert.match(shared, /report it in your summary instead of fixing it/);
	assert.match(shared, /the files you changed and any unresolved issues\.\n\nYour assignment:\nFix the parser\.$/);
	assert.doesNotMatch(replicationAssignment("Fix the parser.", "worktree"), /Do not commit|files you changed/);
});

it("reports where the copy's changes are after each integration outcome", () => {
	const worktree = { path: "/repo-worktrees/fix", branch: "replica/origin/fix" } as any;
	const kept = " Its work, including uncommitted changes, is kept in /repo-worktrees/fix on branch replica/origin/fix.";
	const plan = (paths: string[]) => ({ paths }) as any;
	assert.equal(replicaWorkReport({ worktree, integration: { status: "applied" }, joinPlan: plan(["a.txt", "src/b.ts"]) }, false),
		"Its changes were applied to your working directory and are not committed: a.txt, src/b.ts.");
	const many = Array.from({ length: 23 }, (_, index) => `f${index}.txt`);
	assert.equal(replicaWorkReport({ worktree, integration: { status: "applied" }, joinPlan: plan(many) }, false),
		`Its changes were applied to your working directory and are not committed: ${many.slice(0, 20).join(", ")}, and 3 more.`);
	assert.equal(replicaWorkReport({ worktree, integration: { status: "applied" }, joinPlan: plan([]) }, false), "It had no file changes to apply to your working directory.");
	assert.equal(replicaWorkReport({ worktree, integration: { status: "conflict" } }, false), `The copy finished, but its changes conflict with your current work and were not included.${kept}`);
	assert.equal(replicaWorkReport({ worktree, integration: { status: "not-attempted" } }, true), `The copy's unfinished work was not included in your work.${kept}`);
	assert.equal(replicaWorkReport({ worktree, integration: { status: "blocked" } }, false), `The copy finished, but its changes could not be safely included in your work.${kept}`);
	assert.equal(replicaWorkReport({ integration: { status: "blocked" } }, false), "The copy finished, but its changes could not be safely included in your work.");
	assert.equal(replicaWorkReport({ mode: "shared", integration: { status: "shared" } }, false), "");
	assert.equal(replicaWorkReport({ mode: "shared", integration: { status: "not-attempted" } }, true), "The copy worked in the shared directory; partial changes may already be present.");
});

it("passes valid caller names unchanged to launch", async () => {
	const surface = toolSurface(), ctx = surface.context("original");
	for (const name of ["review", "check-auth-risks", "check-types-2"]) {
		const result = await surface.definition().execute("call", { name, task: "review" }, undefined, undefined, ctx);
		assert.equal(surface.launches.at(-1).name, name);
		assert.equal(result.details.name, name);
	}
});
it("rejects old continuation arguments through direct execution", async () => {
	const surface = toolSurface(), ctx = surface.context("original");
	for (const extra of [
		{ continuation: "old", mode: "resume" },
		{ continuation: "old", mode: "fork" },
		{ continuation: undefined },
		{ mode: undefined },
		{ resume: "old" },
		{ fork: true },
	]) {
		await assert.rejects(surface.definition().execute("call", { name: "continue-check", task: "continue", ...extra }, undefined, undefined, ctx), /only name and task/);
	}
	assert.equal(surface.launches.length, 0);
});
it("copies only the captured branch and settles inherited pending calls without executing them", () => {
	const dir = mkdtempSync(join(tmpdir(), "replication-contract-"));
	try {
		const parent = join(dir, "parent.jsonl"), child = join(dir, "child.jsonl");
		writeFileSync(parent, JSON.stringify({ type: "session", id: "parent", cwd: dir }) + "\n" + JSON.stringify({ type: "message", id: "other-branch", message: { role: "user", content: [{ type: "text", text: "other branch" }] } }) + "\n");
		const branch = [
			{ type: "message", id: "current-user", parentId: "not-in-branch", message: { role: "user", content: [{ type: "text", text: "current request" }] } },
			{ type: "message", id: "pending", parentId: "current-user", message: { role: "assistant", content: [{ type: "toolCall", id: "one", name: "replicate" }, { type: "toolCall", id: "two", name: "bash" }] } },
		];
		seedReplicationSessionFile({ parentSessionFile: parent, childSessionFile: child, childCwd: dir, entries: branch, contextMessages: buildSessionContext(branch as any).messages });
		const rows = readFileSync(child, "utf8").trim().split("\n").map((line) => JSON.parse(line));
		assert.notEqual(rows[0].id, "parent");
		assert.equal(rows[0].cwd, dir);
		assert.deepEqual(rows.slice(1, 3).map((row) => row.id), ["current-user", "pending"]);
		assert.equal(rows[1].parentId, null);
		assert.deepEqual(rows.slice(3).map((row) => row.message.toolCallId), ["one", "two"]);
		assert.equal(rows[4].parentId, rows[3].id);
		assert.equal(branch[0].parentId, "not-in-branch", "the caller snapshot is not mutated");
	} finally { rmSync(dir, { recursive: true, force: true }); }
});

for (const resumeSessionId of [undefined, "saved-copy"]) {
	it(`keeps conversation and runtime without replaying extension control state (${resumeSessionId ? "resume" : "fork"})`, () => {
		const dir = mkdtempSync(join(tmpdir(), "replication-controls-"));
		try {
			const branch: any[] = [
				{ type: "model_change", id: "model", provider: "local", modelId: "test" },
				{ type: "thinking_level_change", id: "thinking", thinkingLevel: "high" },
				{ type: "message", id: "user", message: { role: "user", content: [{ type: "text", text: "current assignment context" }] } },
				{ type: "custom", id: "queue", customType: "ask:queued", data: { requestId: "parent-question" } },
				{ type: "custom", id: "ready", customType: "ask:queue-completed", data: { requestId: "parent-question" } },
				{ type: "custom", id: "other-control", customType: "another-extension:pending", data: { active: true } },
				{ type: "custom_message", id: "answer", customType: "ask:background-answer", content: "already delivered context", display: true, details: {} },
			];
			branch.forEach((row, i) => { row.parentId = i ? branch[i - 1].id : null; });
			const original = JSON.stringify(branch);
			const context = buildSessionContext(branch);
			const child = join(dir, "child.jsonl");
			seedReplicationSessionFile({ parentSessionFile: join(dir, "parent.jsonl"), childSessionFile: child, childCwd: dir, entries: branch, contextMessages: context.messages, resumeSessionId });
			const rows = readFileSync(child, "utf8").trim().split("\n").map((line) => JSON.parse(line));
			assert.deepEqual(rows.filter((row) => row.type === "custom"), [], "pending control state belongs to its source, not a launched attempt");
			assert.deepEqual(buildSessionContext(rows.slice(1)), context, "model, thinking and conversation stay unchanged");
			assert.equal(rows.at(-1).parentId, "user");
			if (resumeSessionId) assert.equal(rows[0].id, resumeSessionId);
			assert.equal(JSON.stringify(branch), original);
		} finally { rmSync(dir, { recursive: true, force: true }); }
	});
}

it("keeps compacted context when its first retained entry was extension control state", () => {
	const dir = mkdtempSync(join(tmpdir(), "replication-control-compaction-"));
	try {
		const branch: any[] = [
			{ type: "custom", id: "control", parentId: null, customType: "pending", data: {} },
			{ type: "message", id: "kept", parentId: "control", message: { role: "user", content: [{ type: "text", text: "keep this fact" }] } },
			{ type: "compaction", id: "compact", parentId: "kept", firstKeptEntryId: "control", summary: "older facts", tokensBefore: 1000 },
		];
		const context = buildSessionContext(branch), child = join(dir, "child.jsonl");
		seedReplicationSessionFile({ parentSessionFile: join(dir, "parent.jsonl"), childSessionFile: child, childCwd: dir, entries: branch, contextMessages: context.messages });
		const rows = readFileSync(child, "utf8").trim().split("\n").map((line) => JSON.parse(line));
		assert.deepEqual(rows.filter((row) => row.type === "custom"), []);
		assert.deepEqual(buildSessionContext(rows.slice(1)), context);
	} finally { rmSync(dir, { recursive: true, force: true }); }
});
it("does not add outputs for abandoned, errored or compacted historical calls", () => {
	const dir = mkdtempSync(join(tmpdir(), "replication-orphans-"));
	try {
		const branch = [
			{ type: "message", id: "error", parentId: null, message: { role: "assistant", stopReason: "error", content: [{ type: "toolCall", id: "failed-call", name: "write" }] } },
			{ type: "message", id: "abandoned", parentId: "error", message: { role: "assistant", stopReason: "toolUse", content: [{ type: "toolCall", id: "abandoned-call", name: "bash" }] } },
			{ type: "message", id: "user", parentId: "abandoned", message: { role: "user", content: [{ type: "text", text: "current request" }] } },
			{ type: "compaction", id: "compact", parentId: "user", firstKeptEntryId: "user", summary: "older context", tokensBefore: 1000 },
			{ type: "message", id: "current", parentId: "compact", message: { role: "assistant", stopReason: "toolUse", content: [{ type: "toolCall", id: "current-call", name: "replicate" }] } },
		];
		const child = join(dir, "child.jsonl");
		seedReplicationSessionFile({ parentSessionFile: join(dir, "original.jsonl"), childSessionFile: child, childCwd: dir, entries: branch, contextMessages: buildSessionContext(branch as any).messages });
		const outputs = readFileSync(child, "utf8").trim().split("\n").map((line) => JSON.parse(line)).filter((row) => row.message?.role === "toolResult");
		assert.deepEqual(outputs.map((row) => row.message.toolCallId), ["current-call"]);
	} finally { rmSync(dir, { recursive: true, force: true }); }
});

it("saves all post-fork answer text in order without inherited answers, tools or reasoning", () => {
	const dir = mkdtempSync(join(tmpdir(), "replication-history-"));
	try {
		const session = join(dir, "child.jsonl");
		const longAnswer = "answer line\n".repeat(10_000);
		const rows = [
			{ type: "session", id: "clone", version: 3, cwd: dir },
			{ type: "message", id: "inherited", message: { role: "assistant", content: [{ type: "text", text: "ORIGINAL_ANSWER" }] } },
			{ type: "message", id: "first", message: { role: "assistant", content: [{ type: "thinking", thinking: "HIDDEN_REASONING" }, { type: "text", text: "FIRST_ANSWER" }, { type: "toolCall", name: "bash", arguments: { command: "SECRET_TOOL_INPUT" } }] } },
			{ type: "message", id: "tool", message: { role: "toolResult", content: [{ type: "text", text: "TOOL_OUTPUT" }] } },
			{ type: "message", id: "last", message: { role: "assistant", content: [{ type: "text", text: longAnswer }] } },
		];
		writeFileSync(session, rows.map((row) => JSON.stringify(row)).join("\n") + "\n");
		seedSessionBinding(session, { version: 1, storeDir: join(dir, "store"), child: { lineage: { rootDir: join(dir, "lineage"), rootId: "root", nodeId: "clone", launchKind: "fork" }, environment: { PI_SUBAGENT_REPLICATION_ASSISTANTS: JSON.stringify(["inherited"]) } } });
		const path = materializeReplicationHistory(session, "clone", "replica");
		const history = readFileSync(path, "utf8");
		assert.ok(history.includes(longAnswer));
		assert.ok(history.indexOf("FIRST_ANSWER") < history.indexOf(longAnswer));
		assert.doesNotMatch(history, /ORIGINAL_ANSWER|HIDDEN_REASONING|SECRET_TOOL_INPUT|TOOL_OUTPUT/);
		assert.equal(materializeReplicationHistory(session, "clone", "replica"), path, "recovery reuses the immutable history");
	} finally { rmSync(dir, { recursive: true, force: true }); }
});
