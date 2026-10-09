import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { getProviderRequests, resetProviderRequests } from "./fake-provider.ts";
import { cleanupTestEnv, closePane, createTestEnv, createTrackedSurface, getAvailableBackends, runInPane, shellQuote, sleep, startPi, waitForPaneAbsence, waitForPaneReady, waitForScreen, type TestEnv } from "./harness.ts";
import { childSessionLocation, readSessionBinding } from "../../pi-extension/subagents/session-binding.ts";

const packageTools = new Set(["replicate", "subagent", "subagent_resume", "subagent_interrupt", "subagent_cancel", "subagents_list", "caller_ping", "subagent_done"]);
function entries(path: string): any[] {
	return existsSync(path) ? readFileSync(path, "utf8").trim().split("\n").map((line) => JSON.parse(line)) : [];
}
async function waitUntil(check: () => boolean, explanation: string): Promise<void> {
	const deadline = Date.now() + 20_000;
	while (Date.now() < deadline) {
		if (check()) return;
		await sleep(50);
	}
	assert.fail(explanation);
}
function systemText(request: ReturnType<typeof getProviderRequests>[number]): string {
	return JSON.stringify(request.messages.filter((message) => message.role === "system"));
}

for (const backend of getAvailableBackends()) {
	describe(`replication (${backend})`, { timeout: 45_000 }, () => {
		let env: TestEnv;
		beforeEach(() => { resetProviderRequests(); env = createTestEnv(backend, { replication: true }); });
		afterEach(async () => { await cleanupTestEnv(env); });

		for (const task of ["REPLICATION_FAIL_WITH_HISTORY", "Return exactly EMPTY_COMPLETION"]) {
			it(`reports ${task} as failure and closes its clone`, async () => {
				const parentFile = join(env.dir, "failure-original.jsonl");
				const parent = createTrackedSurface(env, "failure-original");
				await waitForPaneReady(parent);
				startPi(parent, env.dir, "Return exactly INHERITED_ANSWER_NOT_HISTORY", { extraArgs: `--session ${shellQuote(parentFile)}` });
				await waitUntil(() => entries(parentFile).some((entry) => entry.message?.role === "assistant" && JSON.stringify(entry.message.content).includes("INHERITED_ANSWER_NOT_HISTORY")), "the inherited answer must be saved before cloning");
				runInPane(parent, `Call the replicate tool once with task: ${JSON.stringify(task)}`);
				await waitUntil(() => entries(parentFile).some((entry) => entry.customType === "subagent_result"), "failure must wake the original");
				const results = entries(parentFile).filter((entry) => entry.customType === "subagent_result");
				assert.equal(results.length, 1);
				const result = results[0];
				assert.match(result.content, /Replica .* error/);
				assert.match(result.content, task === "REPLICATION_FAIL_WITH_HISTORY" ? /deterministic replica terminal failure/ : /no required summary/);
				const history = readFileSync(result.details.historyPath, "utf8");
				assert.doesNotMatch(history, /INHERITED_ANSWER_NOT_HISTORY|TOOL_OUTPUT_NOT_AN_ANSWER|echo TOOL_OUTPUT|Call the replicate tool/);
				if (task === "REPLICATION_FAIL_WITH_HISTORY") assert.match(history, /REPLICA_FIRST_ANSWER/);
				else assert.match(history, /No textual answers were produced/);
				const binding = readSessionBinding(result.details.sessionFile)!;
				const location = childSessionLocation(binding.child!.lineage.rootDir, binding.child!.lineage.nodeId)!;
				assert.equal(await waitForPaneAbsence(location.paneId!, { timeoutMs: 10_000 }), true);
			});
		}
		it("forks the current conversation with one inherited tool surface and returns one summary", async () => {
			const parentFile = join(env.dir, "original.jsonl");
			const capability = join(env.dir, "parent-only-capability.ts");
			writeFileSync(capability, `import { Type } from ${JSON.stringify(new URL("../../node_modules/@sinclair/typebox/build/esm/index.mjs", import.meta.url).pathname)};\nexport default function(pi) { pi.on('before_agent_start', (event) => ({systemPrompt: event.systemPrompt + '\\nCUSTOM_CAPABILITY_SYSTEM'})); pi.registerTool({name:'replication_probe',label:'Probe',description:'Verify inherited capability',parameters:Type.Object({}),async execute(){return {content:[{type:'text',text:'CAPABILITY_INHERITED'}],details:{}}}}); }\n`);
			const parent = createTrackedSurface(env, "replication-original");
			await waitForPaneReady(parent);
			startPi(parent, env.dir, "Earlier fact: EARLIER_REPLICATION_CONTEXT. Return exactly ORIGINAL_READY", { extraArgs: `--session ${shellQuote(parentFile)} -e ${shellQuote(capability)}` });
			await waitUntil(() => entries(parentFile).some((entry) => entry.message?.role === "assistant" && JSON.stringify(entry.message.content).includes("ORIGINAL_READY")), "the original must persist its initial answer, not just echo the input");
			const first = getProviderRequests()[0];
			assert.deepEqual(first.tools.filter((name) => packageTools.has(name)), ["replicate"]);

			runInPane(parent, 'Current fact: CURRENT_REPLICATION_CONTEXT. Call the replicate tool once with task: "Use replication_probe then Return exactly REPLICATION_SUMMARY"');
			await waitUntil(() => entries(parentFile).some((entry) => entry.type === "custom_message" && entry.customType === "subagent_result"), "the original must receive its clone summary");
			const deliveries = entries(parentFile).filter((entry) => entry.type === "custom_message" && entry.customType === "subagent_result");
			assert.equal(deliveries.length, 1);
			assert.match(deliveries[0].content, /REPLICATION_SUMMARY/);
			assert.ok(existsSync(deliveries[0].details.resultPath));
			const childFile = deliveries[0].details.sessionFile;
			const binding = readSessionBinding(childFile);
			assert.ok(binding?.child);
			assert.equal(entries(childFile)[0].cwd, env.dir);
			const childRequest = getProviderRequests().find((request) => request.userText.includes("REPLICATION_SUMMARY") && !request.userText.includes("Call the replicate tool"));
			assert.ok(childRequest, "the clone must make a real provider request");
			assert.match(childRequest.text, /EARLIER_REPLICATION_CONTEXT/);
			assert.match(childRequest.text, /CURRENT_REPLICATION_CONTEXT/);
			assert.equal(systemText(childRequest), systemText(first));
			assert.equal(childRequest.model, first.model);
			assert.deepEqual(childRequest.tools, first.tools);
			assert.ok(entries(childFile).some((entry) => entry.message?.role === "toolResult" && entry.message.toolName === "replication_probe" && JSON.stringify(entry.message.content).includes("CAPABILITY_INHERITED")), "the inherited custom tool must actually execute");
			assert.deepEqual(childRequest.tools.filter((name) => packageTools.has(name)), ["replicate"]);
			const location = childSessionLocation(binding.child.lineage.rootDir, binding.child.lineage.nodeId);
			assert.ok(location?.paneId);
			assert.equal(await waitForPaneAbsence(location.paneId, { timeoutMs: 10_000 }), true);
			// The clone closes only its own surface, not the original's.
			runInPane(parent, "Return exactly ORIGINAL_STILL_OPEN");
			await waitForScreen(parent, /ORIGINAL_STILL_OPEN/);
			closePane(parent);
		});
	});
}
