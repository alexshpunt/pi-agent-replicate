import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { reduceLineage } from "../../pi-extension/subagents/lineage.ts";
import { childSessionLocation, parentSessionLocation, readSessionBinding, sessionLineageRoots } from "../../pi-extension/subagents/session-binding.ts";
import { readReplicaWork } from "../../pi-extension/subagents/replica-work.ts";
import { getProviderRequests, resetProviderRequests } from "./fake-provider.ts";
import { cleanupTestEnv, closePane, createTestEnv, createTrackedSurface, getAvailableBackends, runInPane, readPane, restartIsolatedHerdr, shellQuote, sleep, startPi, waitForPaneAbsence, waitForPaneReady, waitForPiExit, waitForScreen, PI_TIMEOUT, type TestEnv } from "./harness.ts";

function entries(path: string): any[] { return existsSync(path) ? readFileSync(path, "utf8").trim().split("\n").map((line) => JSON.parse(line)) : []; }
function results(path: string): any[] { return entries(path).filter((entry) => entry.customType === "subagent_result"); }
async function waitUntil(check: () => boolean, explanation: string): Promise<void> {
	const deadline = Date.now() + PI_TIMEOUT;
	while (Date.now() < deadline) { if (check()) return; await sleep(50); }
	assert.fail(explanation);
}
const teleportSource = process.env.PI_TEST_TELEPORT_SOURCE;
for (const backend of getAvailableBackends()) {
	describe(`replication moves (${backend})`, { timeout: PI_TIMEOUT * 2 }, () => {
		let env: TestEnv;
		beforeEach(() => { resetProviderRequests(); env = createTestEnv(backend, { replication: true }); });
		afterEach(async () => { await cleanupTestEnv(env); });
		it("joins saved successful work once after a complete isolated Herdr restart", async () => {
			const original = join(env.dir, "restart-original.jsonl"), capability = join(env.dir, "restart-capability.ts");
			const gate = join(env.dir, ".pi", "agent", "restart-gate"), started = gate + ".started";
			writeFileSync(capability, `import {Type} from ${JSON.stringify(new URL("../../node_modules/@sinclair/typebox/build/esm/index.mjs", import.meta.url).pathname)}; import {existsSync,writeFileSync} from 'node:fs'; import {join} from 'node:path'; export default function(pi){pi.registerTool({name:'replication_probe',label:'Probe',description:'Write recoverable source',parameters:Type.Object({}),async execute(){writeFileSync(join(process.cwd(),'restart.txt'),'SAVED_RESTART_SOURCE');writeFileSync(${JSON.stringify(started)},'ready');const end=Date.now()+20000;while(!existsSync(${JSON.stringify(gate)})&&Date.now()<end)await new Promise(r=>setTimeout(r,25));if(!existsSync(${JSON.stringify(gate)}))throw new Error('gate timeout');return {content:[{type:'text',text:'saved source'}],details:{}}}});}\n`);
			const parent = createTrackedSurface(env, "restart-original");
			await waitForPaneReady(parent);
			startPi(parent, env.dir, "Return exactly RESTART_READY", { extraArgs: `--session ${shellQuote(original)} -e ${shellQuote(capability)}` });
			await waitUntil(() => entries(original).some((row) => row.message?.role === "assistant"), "parent ready");
			runInPane(parent, 'Call the replicate tool once with task: "Use replication_probe then Return exactly RESTART_SUMMARY"');
			await waitUntil(() => existsSync(started), "child must write its source before shutdown");
			const binding = readSessionBinding(original)!;
			const root = sessionLineageRoots(binding.storeDir, binding.sessionId)[0];
			const node = [...reduceLineage(root).nodes.values()].find((entry) => entry.parentSessionId === binding.sessionId)!;
			runInPane(parent, "/quit"); await waitForPiExit(parent); closePane(parent);
			writeFileSync(gate, "go");
			await waitUntil(() => existsSync(node.sessionFile + ".exit"), "child result must be durable before Herdr dies");
			assert.equal(existsSync(join(env.dir, "restart.txt")), false);
			await restartIsolatedHerdr(env);
			const receiver = createTrackedSurface(env, "restart-receiver");
			await waitForPaneReady(receiver);
			startPi(receiver, env.dir, "", { extraArgs: `--session ${shellQuote(original)}` });
			try {
				await waitUntil(() => results(original).length === 1, "reopened original must join and receive the saved result");
			} catch (error) {
				const recovered = reduceLineage(root).nodes.get(node.nodeId);
				const work = recovered?.replicaWorkFile && existsSync(recovered.replicaWorkFile) ? readReplicaWork(recovered.replicaWorkFile) : undefined;
				assert.fail(`${error}\n${JSON.stringify({
					receiver: readPane(receiver, 150),
					parent: parentSessionLocation(binding.storeDir, binding.sessionId),
					child: childSessionLocation(root, node.nodeId),
					lineage: { terminal: recovered?.terminal, delivered: recovered?.terminalDelivered, cleanup: recovered?.cleanupPending },
					work: work && { completion: work.completion, integration: work.integration, checkpointError: work.checkpointError, sessionFile: work.sessionFile, sessionCheckpoint: work.sessionCheckpoint },
					sidecar: existsSync(node.sessionFile + ".exit") ? readFileSync(node.sessionFile + ".exit", "utf8") : null,
				})}`);
			}
			assert.match(results(original)[0].content, /RESTART_SUMMARY/);
			assert.equal(results(original)[0].details.integration.status, "applied");
			assert.equal(readFileSync(join(env.dir, "restart.txt"), "utf8"), "SAVED_RESTART_SOURCE");
			assert.ok(existsSync(results(original)[0].details.resultPath));
			runInPane(receiver, "/quit"); await waitForPiExit(receiver); closePane(receiver);
			const reopened = createTrackedSurface(env, "second-receiver");
			await waitForPaneReady(reopened);
			startPi(reopened, env.dir, "Return exactly SECOND_REOPENED", { extraArgs: `--session ${shellQuote(original)}` });
			await waitForScreen(reopened, /SECOND_REOPENED/);
			assert.equal(results(original).length, 1, "durable result must not replay again");
		});
		it("drains nested copies through real Teleport and replays the direct result only to its reopened original", { skip: !teleportSource }, async () => {
			assert.ok(teleportSource && existsSync(teleportSource));
			const agentDir = join(env.dir, ".pi", "agent");
			writeFileSync(join(agentDir, "extensions", "teleport-under-test.ts"), `export { default } from ${JSON.stringify(teleportSource)};\n`);
			assert.ok(process.env.PI_INTEGRATION_HERDR_AGENT_DIR);
			cpSync(agentDir, process.env.PI_INTEGRATION_HERDR_AGENT_DIR, { recursive: true });
			const original = join(env.dir, "original.jsonl"), gate = join(env.dir, "grandchild-gate");
			const capability = join(env.dir, "nested-capability.ts");
			writeFileSync(capability, `import {Type} from ${JSON.stringify(new URL("../../node_modules/@sinclair/typebox/build/esm/index.mjs", import.meta.url).pathname)}; import {writeFileSync} from 'node:fs'; import {join} from 'node:path'; export default function(pi){pi.registerTool({name:'replication_probe',label:'Probe',description:'Write nested source',parameters:Type.Object({}),async execute(){writeFileSync(join(process.cwd(),'nested.txt'),'GRANDCHILD_SOURCE');return {content:[{type:'text',text:'nested source written'}],details:{}}}});}\n`);
			const parent = createTrackedSurface(env, "nested-original");
			await waitForPaneReady(parent);
			startPi(parent, env.dir, `Call the replicate tool once with task: "REPLICATION_NESTED_OWNER INTEGRATION_DESCENDANT_GATE: ${gate}"`, { extraArgs: `--session ${shellQuote(original)} -e ${shellQuote(join(agentDir, "extensions", "teleport-under-test.ts"))} -e ${shellQuote(capability)}`, agentDir: process.env.PI_INTEGRATION_HERDR_AGENT_DIR });
			const nodes = () => {
				const binding = readSessionBinding(original);
				return binding ? sessionLineageRoots(binding.storeDir, binding.sessionId).flatMap((root) => [...reduceLineage(root).nodes.values()]) : [];
			};
			try { await waitUntil(() => nodes().filter((node) => node.replication).length === 2, "one clone must launch one descendant"); } catch (error) { assert.fail(`${error}\n${JSON.stringify({ parent: entries(original).filter((row) => row.customType === "subagent_result" || row.message?.role === "toolResult"), children: nodes().map((node) => ({ id: node.nodeId, session: node.sessionFile ? entries(node.sessionFile).slice(-4) : [], screen: node.surface ? readPane(node.surface, 150) : "" })) })}`); }
			const owner = nodes().find((node) => node.task?.includes("Your assignment:\nREPLICATION_NESTED_OWNER"));
			assert.ok(owner?.sessionFile && owner.surface);
			const grandchild = nodes().find((node) => node.parentNodeId === owner.nodeId);
			assert.ok(grandchild?.sessionFile);
			await waitForScreen(owner.surface, /REPLICATION_OWNER_WAITING/);
			assert.ok(getProviderRequests().some((request) => request.userText.includes("Your assignment:\nREPLICATION_NESTED_OWNER") && request.tools.includes("teleport")), "the clone must inherit Teleport from its original");
			assert.equal(results(original).length, 0, "a temporary response cannot finish an owner with pending copies");
			const ownerBinding = readSessionBinding(owner.sessionFile)!;
			assert.ok(owner.worktree?.path);
			const destination = join(owner.worktree.path, "owner-destination"); mkdirSync(destination);
			runInPane(owner.surface, `Call the teleport tool with EXACT parameters: action: "jump" target: "${destination}"`);
			const location = () => childSessionLocation(ownerBinding.child!.lineage.rootDir, owner.nodeId);
			await waitUntil(() => location()?.cwd === destination && !existsSync(owner.sessionFile!), "real Teleport must replace the owner's file and pane");
			const moved = location()!.sessionFile;
			runInPane(parent, "/quit"); await waitForPiExit(parent); closePane(parent);
			writeFileSync(gate, "go");
			await waitUntil(() => results(moved).length === 1, "the descendant summary must reach its moved immediate parent");
			assert.equal(results(moved)[0].details.childId, grandchild.nodeId);
			assert.match(results(moved)[0].content, /REPLICATION_GRANDCHILD/);
			assert.equal(results(moved)[0].details.integration.status, "applied");
			await waitUntil(() => entries(moved).some((entry) => entry.message?.role === "assistant" && JSON.stringify(entry.message.content).includes("REPLICATION_NESTED_SUMMARY")), "the owner must summarize after receiving its copy");
			assert.equal(results(original).length, 0, "a closed original must not be opened automatically");
			assert.equal(readFileSync(join(owner.worktree.path, "nested.txt"), "utf8"), "GRANDCHILD_SOURCE");
			assert.equal(existsSync(join(env.dir, "nested.txt")), false, "closed parent must not join prematurely");

			const copied = join(env.dir, "new-id-copy.jsonl"), copiedRows = entries(original); copiedRows[0].id = randomUUID();
			writeFileSync(copied, copiedRows.map((row) => JSON.stringify(row)).join("\n") + "\n");
			const foreign = createTrackedSurface(env, "new-id-copy"); await waitForPaneReady(foreign);
			startPi(foreign, env.dir, "Return exactly COPY_STILL_OPEN", { extraArgs: `--session ${shellQuote(copied)}` }); await waitForScreen(foreign, /COPY_STILL_OPEN/);
			assert.equal(results(copied).length, 0, "a new-ID fork cannot take original delivery");
			const receiver = createTrackedSurface(env, "reopened-original"); await waitForPaneReady(receiver);
			startPi(receiver, env.dir, "Return exactly ORIGINAL_REOPENED", { extraArgs: `--session ${shellQuote(original)}` });
			await waitUntil(() => results(original).length === 1, "reopening the exact original must deliver the saved owner result");
			assert.equal(results(original)[0].details.childId, owner.nodeId);
			assert.match(results(original)[0].content, /REPLICATION_NESTED_SUMMARY/);
			assert.equal(results(original)[0].details.integration.status, "applied");
			assert.equal(readFileSync(join(env.dir, "nested.txt"), "utf8"), "GRANDCHILD_SOURCE");
			await waitUntil(() => getProviderRequests().some((request) => /Replica .* completed\./.test(request.userText) && request.userText.includes("REPLICATION_NESTED_SUMMARY")), "replay must start a real agent turn");
			assert.equal(await waitForPaneAbsence(location()!.paneId!, { timeoutMs: 10_000 }), true);
			assert.equal(results(original).length, 1);
			assert.equal(results(copied).length, 0);
			runInPane(foreign, "Return exactly UNRELATED_SURVIVED"); await waitForScreen(foreign, /UNRELATED_SURVIVED/);
		});
	});
}
