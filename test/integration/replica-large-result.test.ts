import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { readSessionBinding } from "../../pi-extension/subagents/session-binding.ts";
import { resetProviderRequests } from "./fake-provider.ts";
import { cleanupTestEnv, createTestEnv, createTrackedSurface, getAvailableBackends, PI_TIMEOUT, readPane, runInPane, shellQuote, sleep, startPi, waitForPaneReady, type TestEnv } from "./harness.ts";

function entries(file: string): any[] {
	if (!existsSync(file)) return [];
	const text = readFileSync(file, "utf8");
	return text.slice(0, text.lastIndexOf("\n") + 1).split("\n").filter(Boolean).map(line => JSON.parse(line));
}

async function until(check: () => boolean, reason: string, pane: string): Promise<void> {
	const deadline = Date.now() + PI_TIMEOUT;
	while (Date.now() < deadline) { if (check()) return; await sleep(50); }
	assert.fail(`${reason}\n${readPane(pane, 100)}`);
}

for (const backend of getAvailableBackends()) {
	describe(`replica large result (${backend})`, { timeout: PI_TIMEOUT * 2 }, () => {
		let env: TestEnv;
		beforeEach(() => { resetProviderRequests(); env = createTestEnv(backend, { replication: true }); });
		afterEach(async () => { await cleanupTestEnv(env); });

		it("delivers the complete large answer with its durable result and exact child session", async () => {
			const parentFile = join(env.dir, "large-parent.jsonl");
			const parent = createTrackedSurface(env, "large-parent");
			await waitForPaneReady(parent);
			startPi(parent, env.dir, "Return exactly LARGE_PARENT_READY", { extraArgs: `--session ${shellQuote(parentFile)}` });
			await until(() => entries(parentFile).some(row => row.message?.role === "assistant"), "parent did not start", parent);
			runInPane(parent, 'Call the replicate tool once with name: "large-copy", task: "INTEGRATION_LARGE_RESULT"');
			await until(() => entries(parentFile).some(row => row.type === "custom_message" && row.customType === "subagent_result"), "replica result was not delivered", parent);
			await until(() => {
				const rows = entries(parentFile);
				const delivery = rows.findIndex(row => row.type === "custom_message" && row.customType === "subagent_result");
				return delivery >= 0 && rows.slice(delivery + 1).some(row => row.message?.role === "assistant");
			}, "parent did not finish processing the result", parent);

			const rows = entries(parentFile);
			const deliveries = rows.filter(row => row.type === "custom_message" && row.customType === "subagent_result");
			assert.equal(deliveries.length, 1);
			const delivery = deliveries[0];
			const launch = rows.find(row => row.message?.role === "toolResult" && row.message.toolName === "replicate")?.message;
			assert.ok(launch?.details?.id);
			assert.equal(delivery.details.childId, launch.details.id);
			assert.equal(delivery.details.parentToolCallId, launch.toolCallId);
			assert.equal(delivery.details.exitCode, 0);
			assert.equal(delivery.details.integration.status, "applied");

			const expected = `LARGE_RESULT_BEGIN\n${"x".repeat(20_000)}\nLARGE_RESULT_END`;
			assert.equal(typeof delivery.content, "string");
			assert.ok(delivery.content.includes(expected), "the delivered answer must not be truncated");
			assert.ok(delivery.details.resultContent.includes(expected), "the model-visible result must include the complete answer");
			assert.equal(typeof delivery.details.resultPath, "string");
			assert.ok(isAbsolute(delivery.details.resultPath));
			assert.ok(existsSync(delivery.details.resultPath));
			assert.ok(readFileSync(delivery.details.resultPath, "utf8").includes(expected), "the durable file must retain the complete answer");

			const childFile = delivery.details.sessionFile;
			assert.equal(typeof childFile, "string");
			assert.ok(isAbsolute(childFile));
			assert.ok(existsSync(childFile));
			const binding = readSessionBinding(childFile);
			assert.equal(binding?.child?.lineage.nodeId, launch.details.id, "the result must identify the launched child");
			assert.ok(entries(childFile).some(row => row.message?.role === "assistant" && row.message.content?.some((part: any) => part.type === "text" && part.text === expected)), "the exact child session must contain the complete answer");
		});
	});
}
