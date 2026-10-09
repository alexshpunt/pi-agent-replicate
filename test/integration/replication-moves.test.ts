import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { reduceLineage } from "../../pi-extension/subagents/lineage.ts";
import { childSessionLocation, readSessionBinding, sessionLineageRoots } from "../../pi-extension/subagents/session-binding.ts";
import { getProviderRequests, resetProviderRequests } from "./fake-provider.ts";
import { cleanupTestEnv, closePane, createTestEnv, createTrackedSurface, getAvailableBackends, runInPane, shellQuote, sleep, startPi, waitForPaneAbsence, waitForPaneReady, waitForPiExit, waitForScreen, type TestEnv } from "./harness.ts";

function entries(path: string): any[] { return existsSync(path) ? readFileSync(path, "utf8").trim().split("\n").map((line) => JSON.parse(line)) : []; }
function results(path: string): any[] { return entries(path).filter((entry) => entry.customType === "subagent_result"); }
async function waitUntil(check: () => boolean, explanation: string): Promise<void> {
	const deadline = Date.now() + 25_000;
	while (Date.now() < deadline) { if (check()) return; await sleep(50); }
	assert.fail(explanation);
}
const teleportSource = process.env.PI_TEST_TELEPORT_SOURCE;
for (const backend of getAvailableBackends()) {
	describe(`replication moves (${backend})`, { timeout: 60_000 }, () => {
		let env: TestEnv;
		beforeEach(() => { resetProviderRequests(); env = createTestEnv(backend, { replication: true }); });
		afterEach(async () => { await cleanupTestEnv(env); });
		it("drains nested copies through real Teleport and replays the direct result only to its reopened original", { skip: !teleportSource }, async () => {
			assert.ok(teleportSource && existsSync(teleportSource));
			const agentDir = join(env.dir, ".pi", "agent");
			writeFileSync(join(agentDir, "extensions", "teleport-under-test.ts"), `export { default } from ${JSON.stringify(teleportSource)};\n`);
			assert.ok(process.env.PI_INTEGRATION_HERDR_AGENT_DIR);
			cpSync(agentDir, process.env.PI_INTEGRATION_HERDR_AGENT_DIR, { recursive: true });
			const original = join(env.dir, "original.jsonl"), gate = join(env.dir, "grandchild-gate");
			const parent = createTrackedSurface(env, "nested-original");
			await waitForPaneReady(parent);
			startPi(parent, env.dir, `Call the replicate tool once with task: "REPLICATION_NESTED_OWNER INTEGRATION_DESCENDANT_GATE: ${gate}"`, { extraArgs: `--session ${shellQuote(original)} -e ${shellQuote(join(agentDir, "extensions", "teleport-under-test.ts"))}`, agentDir: process.env.PI_INTEGRATION_HERDR_AGENT_DIR });
			const nodes = () => {
				const binding = readSessionBinding(original);
				return binding ? sessionLineageRoots(binding.storeDir, binding.sessionId).flatMap((root) => [...reduceLineage(root).nodes.values()]) : [];
			};
			await waitUntil(() => nodes().filter((node) => node.replication).length === 2, "one clone must launch one descendant");
			const owner = nodes().find((node) => node.task?.includes("Your assignment:\nREPLICATION_NESTED_OWNER"));
			assert.ok(owner?.sessionFile && owner.surface);
			const grandchild = nodes().find((node) => node.parentNodeId === owner.nodeId);
			assert.ok(grandchild?.sessionFile);
			await waitForScreen(owner.surface, /REPLICATION_OWNER_WAITING/);
			assert.ok(getProviderRequests().some((request) => request.userText.includes("Your assignment:\nREPLICATION_NESTED_OWNER") && request.tools.includes("teleport")), "the clone must inherit Teleport from its original");
			assert.equal(results(original).length, 0, "a temporary response cannot finish an owner with pending copies");
			const ownerBinding = readSessionBinding(owner.sessionFile)!;
			const destination = join(env.dir, "owner-destination"); mkdirSync(destination);
			runInPane(owner.surface, `Call the teleport tool with EXACT parameters: action: "jump" target: "${destination}"`);
			const location = () => childSessionLocation(ownerBinding.child!.lineage.rootDir, owner.nodeId);
			await waitUntil(() => location()?.cwd === destination && !existsSync(owner.sessionFile!), "real Teleport must replace the owner's file and pane");
			const moved = location()!.sessionFile;
			runInPane(parent, "/quit"); await waitForPiExit(parent); closePane(parent);
			writeFileSync(gate, "go");
			await waitUntil(() => results(moved).length === 1, "the descendant summary must reach its moved immediate parent");
			assert.equal(results(moved)[0].details.childId, grandchild.nodeId);
			assert.match(results(moved)[0].content, /REPLICATION_GRANDCHILD/);
			await waitUntil(() => entries(moved).some((entry) => entry.message?.role === "assistant" && JSON.stringify(entry.message.content).includes("REPLICATION_NESTED_SUMMARY")), "the owner must summarize after receiving its copy");
			assert.equal(results(original).length, 0, "a closed original must not be opened automatically");

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
			await waitUntil(() => getProviderRequests().some((request) => /Replica .* completed\./.test(request.userText) && request.userText.includes("REPLICATION_NESTED_SUMMARY")), "replay must start a real agent turn");
			assert.equal(await waitForPaneAbsence(location()!.paneId!, { timeoutMs: 10_000 }), true);
			assert.equal(results(original).length, 1);
			assert.equal(results(copied).length, 0);
			runInPane(foreign, "Return exactly UNRELATED_SURVIVED"); await waitForScreen(foreign, /UNRELATED_SURVIVED/);
		});
	});
}
