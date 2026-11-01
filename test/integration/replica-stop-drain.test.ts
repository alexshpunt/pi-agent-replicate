import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { reduceLineage } from "../../pi-extension/subagents/lineage.ts";
import { childSessionLocation, readSessionBinding, sessionLineageRoots, sessionLocationAlive } from "../../pi-extension/subagents/session-binding.ts";
import { cleanupTestEnv, createTestEnv, createTrackedSurface, getAvailableBackends, interruptPane, PI_TIMEOUT, runInPane, shellQuote, sleep, startPi, waitForPaneReady, type TestEnv } from "./harness.ts";
import { getProviderRequests, resetProviderRequests } from "./fake-provider.ts";

function entries(file: string): any[] {
	return existsSync(file) ? readFileSync(file, "utf8").trim().split("\n").filter(Boolean).map(line => JSON.parse(line)) : [];
}
function results(file: string): any[] { return entries(file).filter(row => row.customType === "subagent_result"); }
async function until(check: () => boolean, explanation: string): Promise<void> {
	const deadline = Date.now() + PI_TIMEOUT;
	while (Date.now() < deadline) { if (check()) return; await sleep(50); }
	assert.fail(explanation);
}

for (const backend of getAvailableBackends()) {
	describe(`replica quit and descendant drain (${backend})`, { timeout: PI_TIMEOUT * 2 }, () => {
		let env: TestEnv;
		beforeEach(() => { resetProviderRequests(); env = createTestEnv(backend, { replication: true }); });
		afterEach(async () => { await cleanupTestEnv(env); });

		it("reports a replica quit during its model request as one failure", async () => {
			const original = join(env.dir, "quit-parent.jsonl"), gate = join(env.dir, "release");
			const parent = createTrackedSurface(env, "quit-parent");
			await waitForPaneReady(parent);
			startPi(parent, env.dir, "Return exactly QUIT_PARENT_READY", { extraArgs: `--session ${shellQuote(original)}` });
			await until(() => entries(original).some(row => row.message?.role === "assistant"), "parent ready");
			runInPane(parent, `Call the replicate tool once with task: ${JSON.stringify(`INTEGRATION_WAIT_FOR_FILE: ${gate} Return exactly STOP_CHILD_SUMMARY`)}`);
			await until(() => entries(original).some(row => row.message?.toolName === "replicate"), "replica launched");
			const launch = entries(original).find(row => row.message?.toolName === "replicate").message.details;
			const binding = readSessionBinding(launch.sessionFile)!;
			const location = () => childSessionLocation(binding.child!.lineage.rootDir, binding.child!.lineage.nodeId);
			await until(() => !!location() && getProviderRequests().some(request => request.userText.includes("Your assignment:") && request.userText.includes("STOP_CHILD_SUMMARY")), "replica model request active");
			const owned = location()!;
			runInPane(owned.paneId!, "/quit");
			await until(() => results(original).length === 1, "quit must return a failure");
			const result = results(original)[0];
			assert.equal(result.details.exitCode, 1);
			assert.match(result.content, /interrupt|abort|closed.*saved completion/i);
			assert.equal(result.details.integration.status, "not-attempted");
			assert.ok(existsSync(result.details.historyPath));
			await until(() => !sessionLocationAlive(owned), "quit must end the replica process");
			assert.equal(results(original).length, 1);
		});

		it("keeps an interrupted replica owner alive until its active descendant drains", async () => {
			const original = join(env.dir, "drain-parent.jsonl"), gate = join(env.dir, "grandchild-gate"), capability = join(env.dir, "drain-capability.ts");
			writeFileSync(capability, `import {Type} from ${JSON.stringify(new URL("../../node_modules/@sinclair/typebox/build/esm/index.mjs", import.meta.url).pathname)}; import {writeFileSync} from 'node:fs'; import {join} from 'node:path'; export default function(pi){pi.registerTool({name:'replication_probe',label:'Probe',description:'Write descendant source',parameters:Type.Object({}),async execute(){writeFileSync(join(process.cwd(),'descendant.txt'),'DESCENDANT_SOURCE');return {content:[{type:'text',text:'source saved'}],details:{}}}});}`);
			const parent = createTrackedSurface(env, "drain-parent");
			await waitForPaneReady(parent);
			startPi(parent, env.dir, "Return exactly DRAIN_PARENT_READY", { extraArgs: `--session ${shellQuote(original)} -e ${shellQuote(capability)}` });
			await until(() => entries(original).some(row => row.message?.role === "assistant"), "parent ready");
			runInPane(parent, `Call the replicate tool once with task: "REPLICATION_NESTED_OWNER INTEGRATION_INTERRUPT_OWNER INTEGRATION_DESCENDANT_GATE: ${gate}"`);
			const nodes = () => {
				const binding = readSessionBinding(original);
				return binding ? sessionLineageRoots(binding.storeDir, binding.sessionId).flatMap(root => [...reduceLineage(root).nodes.values()]) : [];
			};
			await until(() => nodes().filter(node => node.replication).length === 2, "owner launches one descendant");
			const owner = nodes().find(node => !node.parentNodeId && node.replication)!;
			const descendant = nodes().find(node => node.parentNodeId === owner.nodeId)!;
			assert.ok(owner.sessionFile && descendant.sessionFile);
			const binding = readSessionBinding(owner.sessionFile)!;
			const location = () => childSessionLocation(binding.child!.lineage.rootDir, owner.nodeId);
			await until(() => !!location() && getProviderRequests().some(request => request.messages.at(-1)?.role === "tool" && request.userText.includes("INTEGRATION_INTERRUPT_OWNER")), "owner model request remains active");
			interruptPane(location()!.paneId!);
			await until(() => entries(owner.sessionFile!).some(row => row.message?.role === "assistant" && row.message.stopReason === "aborted"), "owner interruption saved");
			// This elapsed-time check proves that descendant drain is not a ten-second stop deadline.
			await sleep(11_000);
			assert.equal(results(original).length, 0, "owner must not report before its descendant drains");
			assert.ok(sessionLocationAlive(location()!), "owner stays available to receive its descendant");
			writeFileSync(gate, "release");
			await until(() => results(original).length === 1, "drained owner returns its interruption");
			const result = results(original)[0];
			assert.equal(result.details.exitCode, 1);
			assert.match(result.content, /interrupt|abort/i);
			assert.equal(result.details.integration.status, "not-attempted");
			assert.equal(results(owner.sessionFile!).length, 1, "descendant reaches its exact immediate parent once");
			assert.equal(results(owner.sessionFile!)[0].details.childId, descendant.nodeId);
			assert.equal(existsSync(join(env.dir, "descendant.txt")), false, "failed owner never joins descendant source into the original");
			assert.equal(readFileSync(join(result.details.worktreePath, "descendant.txt"), "utf8"), "DESCENDANT_SOURCE");
			await until(() => !sessionLocationAlive(location()!), "owner closes after descendant delivery");
			assert.equal(results(original).length, 1);
		});
	});
}
