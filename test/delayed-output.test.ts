import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it } from "node:test";
import { registerReplicateTool } from "../pi-extension/subagents/replication.ts";
import { appendLineageEvent, registerLineage, reduceLineage } from "../pi-extension/subagents/lineage.ts";
import subagentsExtension, { __test__ as __test } from "../pi-extension/subagents/index.ts";
import { trackExecutionOwners } from "../pi-extension/subagents/execution-owner.ts";

it("passes each fresh invocation's actual ID without accepting old continuation controls", async () => {
	let tool: any;
	const calls: unknown[] = [];
	const pi: any = { registerTool: (value: any) => { tool = value; }, on() {} };
	registerReplicateTool(pi, async (_params, _ctx, callId) => {
		calls.push(callId);
		return { id: "child", name: "check", sessionFile: "/saved" };
	});
	const ctx: any = { sessionManager: { getSessionId: () => "parent" } };
	await tool.execute("first", { name: "check", task: "check" }, undefined, undefined, ctx);
	await tool.execute("second", { name: "check-again", task: "check again" }, undefined, undefined, ctx);
	for (const mode of ["resume", "fork"]) {
		await assert.rejects(tool.execute(mode, { name: "check", task: "check", continuation: "child", mode }, undefined, undefined, ctx));
	}
	assert.deepEqual(calls, ["first", "second"]);
});

it("retains invocation ownership in durable launch metadata without reusing an older attempt", () => {
	const dir = mkdtempSync(join(tmpdir(), "replica-output-"));
	try {
		const lineage = registerLineage({ artifactDir: dir, nodeId: "child", parentSessionId: "parent", launchKind: "fresh" });
		const owner = { toolCallId: "outer/1", parentToolCallId: "outer" };
		appendLineageEvent(lineage.rootDir, "first", "launch_metadata", "child", { startTime: 1, executionOwner: owner });
		assert.deepEqual(reduceLineage(lineage.rootDir).nodes.get("child")?.executionOwner, owner);
		appendLineageEvent(lineage.rootDir, "second", "launch_metadata", "child", { startTime: 2 });
		assert.equal(reduceLineage(lineage.rootDir).nodes.get("child")?.executionOwner, undefined, "ownerless resume cannot inherit a previous call");
	} finally { rmSync(dir, { recursive: true, force: true }); }
});

it("links delayed visible results to the recorded root without losing full model content", () => {
	const sent: any[] = [];
	const owner = { toolCallId: "outer/2/1", parentToolCallId: "outer" };
	__test.runningSubagents.set("owned-output", { executionOwner: owner } as any);
	try {
		__test.sendSubagentResult({ sendMessage: (...args: any[]) => { sent.push(args); } } as any, "Complete answer", { childId: "owned-output", exitCode: 1, integration: { status: "conflict" } });
		assert.equal(sent[0][0].details.parentToolCallId, "outer");
		assert.equal(sent[0][0].details.originatingToolCallId, "outer/2/1");
		assert.match(sent[0][0].content, /Complete answer/);
		assert.deepEqual(sent[0][0].details.integration, { status: "conflict" });
		assert.equal(sent[0][0].display, true);
		assert.equal(sent[0][1].triggerTurn, true);
	} finally { __test.runningSubagents.delete("owned-output"); }
	__test.sendSubagentResult({ sendMessage: (...args: any[]) => { sent.push(args); } } as any, "Ownerless answer", { childId: "missing" });
	assert.equal(sent[1][0].details.parentToolCallId, undefined);
});

it("follows real nested edges, keeps concurrent roots separate, and discards finished/session state", () => {
	const handlers = new Map<string, Function>();
	const resolve = trackExecutionOwners({ on: (name: string, handler: Function) => { handlers.set(name, handler); } } as any);
	const start = (toolCallId: string, parentToolCallId?: string) => handlers.get("tool_execution_start")!({ toolCallId, parentToolCallId });
	start("first"); start("second"); start("arbitrary-child", "first"); start("leaf", "arbitrary-child");
	assert.deepEqual(resolve("leaf"), { toolCallId: "leaf", parentToolCallId: "first" });
	assert.deepEqual(resolve("second"), { toolCallId: "second", parentToolCallId: "second" });
	start("looks/nested", "unknown");
	assert.equal(resolve("looks/nested"), undefined, "never split an ID to invent ancestry");
	const captured = resolve("leaf");
	handlers.get("tool_execution_end")!({ toolCallId: "leaf" });
	assert.equal(resolve("leaf"), undefined);
	assert.equal(captured?.parentToolCallId, "first", "a captured launch owner outlives tool execution");
	handlers.get("session_start")!();
	assert.equal(resolve("first"), undefined);
	start("fresh");
	handlers.get("session_shutdown")!();
	assert.equal(resolve("fresh"), undefined);
});

function renderCard(content: string, kind?: string) {
	const renderers = new Map<string, Function>();
	subagentsExtension({
		on() {}, registerTool() {}, registerMessageRenderer: (name: string, render: Function) => { renderers.set(name, render); },
	} as any);
	const theme = { fg: (_color: string, value: string) => value, bg: (_color: string, value: string) => value, bold: (value: string) => value };
	return renderers.get("subagent_result")!({ content, details: { name: "review", kind, resultContent: content } }, { expanded: true }, theme);
}

it("shows a delivered help request as needing help rather than completed work", () => {
	const shown = renderCard("Need a decision", "help-request").render(90).join("\n");
	assert.match(shown, /needs help/);
	assert.doesNotMatch(shown, /completed|✓/);
	assert.match(shown, /Need a decision/);
});

it("keeps a recovered inbox's payload, path and owner together despite newer live state", () => {
	const sent: any[] = [];
	__test.runningSubagents.set("reused-child", { executionOwner: { toolCallId: "new", parentToolCallId: "new-root" }, deliveryPayload: "New terminal answer", resultPath: "/new-terminal.md" } as any);
	try {
		__test.sendSubagentResult({ sendMessage: (message: any) => { sent.push(message); } } as any, "Saved old answer", { childId: "reused-child", kind: "help-request", executionOwner: undefined, resultContent: "Saved old answer", resultPath: "/saved-help.md" });
		assert.equal(sent[0].details.parentToolCallId, undefined);
		assert.match(sent[0].content, /Saved old answer/);
		assert.doesNotMatch(sent[0].content, /New terminal answer/);
		assert.equal(sent[0].details.resultPath, "/saved-help.md");
		__test.sendSubagentResult({ sendMessage: (message: any) => { sent.push(message); } } as any, "Saved owned answer", { childId: "reused-child", executionOwner: { toolCallId: "old", parentToolCallId: "old-root" } });
		assert.equal(sent[1].details.parentToolCallId, "old-root");
		assert.equal(sent[1].details.originatingToolCallId, "old");
		assert.match(sent[1].content, /Saved owned answer/);
		assert.equal(sent[1].details.resultPath, undefined, "an old inbox without a path must not borrow a new terminal path");
	} finally { __test.runningSubagents.delete("reused-child"); }
});

it("keeps the end of long lines in expanded result cards", () => {
	const shown = renderCard("Detailed finding ".repeat(80) + "PAYLOAD_END").render(50).join("\n");
	assert.match(shown, /PAYLOAD_END/);
});
