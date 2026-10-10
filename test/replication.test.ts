import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { it } from "node:test";
import { buildSessionContext } from "@earendil-works/pi-coding-agent";
import { seedReplicationSessionFile } from "../pi-extension/subagents/session.ts";
import { seedSessionBinding } from "../pi-extension/subagents/session-binding.ts";
import { materializeReplicationHistory, registerReplicateTool } from "../pi-extension/subagents/replication.ts";

function toolSurface() {
	let definition: any;
	const handlers = new Map<string, Function>();
	const pi = { registerTool: (tool: any) => { definition = tool; }, on: (event: string, handler: Function) => { handlers.set(event, handler); } };
	const controls = registerReplicateTool(pi as any, async () => ({ id: "copy", name: "copy", sessionFile: "/saved" })) as any;
	const context = (id: string, branch: any[] = []) => ({ sessionManager: { getSessionId: () => id, getBranch: () => branch } });
	return { controls, handlers, context, definition: () => definition };
}

it("starts with only task and reveals recovery for the current receiver", () => {
	const surface = toolSurface();
	surface.handlers.get("session_start")?.({}, surface.context("original"));
	assert.deepEqual(Object.keys(surface.definition().parameters.properties), ["task"]);
	surface.controls.reveal(surface.context("original"));
	assert.deepEqual(Object.keys(surface.definition().parameters.properties), ["task", "continuation", "mode"]);
	assert.equal(surface.definition().name, "replicate");
});

it("restores recovery from its own delivered result, not copied session history", () => {
	const surface = toolSurface();
	const branch = [{ type: "custom_message", customType: "subagent_result", details: { replication: true, recoveryAvailable: true, receiverSessionId: "original" } }];
	surface.handlers.get("session_start")?.({}, surface.context("original", branch));
	assert.deepEqual(Object.keys(surface.definition().parameters.properties), ["task", "continuation", "mode"]);
	surface.handlers.get("session_start")?.({}, surface.context("fresh-copy", branch));
	assert.deepEqual(Object.keys(surface.definition().parameters.properties), ["task"]);
	surface.handlers.get("session_start")?.({}, surface.context("unrelated"));
	assert.deepEqual(Object.keys(surface.definition().parameters.properties), ["task"]);
});

it("does not launch undisclosed recovery through direct execution", async () => {
	const surface = toolSurface(), ctx = surface.context("original");
	surface.handlers.get("session_start")?.({}, ctx);
	await assert.rejects(surface.definition().execute("call", { task: "continue", continuation: "old", mode: "resume" }, undefined, undefined, ctx), /not available/);
	surface.controls.reveal(ctx);
	const result = await surface.definition().execute("call", { task: "continue", continuation: "old", mode: "resume" }, undefined, undefined, ctx);
	assert.equal(result.details.status, "running");
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
