import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { registerLineage } from "../../pi-extension/subagents/lineage.ts";
import { cleanupTestEnv, createTestEnv, createTrackedSurface, getAvailableBackends, runInPane, readPaneAsync, shellQuote, sleep, startPi, waitForPaneReady, waitForScreen, PI_TIMEOUT, type TestEnv } from "./harness.ts";

function entries(file: string): any[] {
	if (!existsSync(file)) return [];
	return readFileSync(file, "utf8").split("\n").filter(Boolean).flatMap(line => { try { return [JSON.parse(line)]; } catch { return []; } });
}
async function waitUntil(check: () => boolean, message: string): Promise<void> {
	const deadline = Date.now() + PI_TIMEOUT;
	while (Date.now() < deadline) { if (check()) return; await sleep(50); }
	assert.fail(message);
}

for (const backend of getAvailableBackends()) describe(`active responsiveness (${backend})`, { timeout: PI_TIMEOUT * 2 }, () => {
	let env: TestEnv;
	beforeEach(() => { env = createTestEnv(backend, { replication: true }); });
	afterEach(async () => {
		console.log((await Promise.all(env.surfaces.map(surface => readPaneAsync(surface, 40).catch(String)))).join("\n"));
		await cleanupTestEnv(env);
	});
	for (const copies of [1, 3]) it(`keeps input and supervision bounded with ${copies} active replicas and historical sessions`, async () => {
		const state = join(env.dir, ".pi", "agent", "responsiveness"); mkdirSync(state);
		const parentFile = join(env.dir, "parent.jsonl");
		const capability = join(env.dir, "responsiveness-capability.ts");
		writeFileSync(capability, `import probe from ${JSON.stringify(new URL("./fixtures/active-replica-probe.ts", import.meta.url).pathname)}; export default pi => probe(pi, ${JSON.stringify(state)});\n`);
		const parent = createTrackedSurface(env, "responsive-parent");
		await waitForPaneReady(parent);
		startPi(parent, env.dir, "Return exactly RESPONSIVE_READY", { extraArgs: `--session ${shellQuote(parentFile)} -e ${shellQuote(capability)}` });
		await waitUntil(() => entries(parentFile).some(row => row.message?.role === "assistant"), "parent ready");
		runInPane(parent, "/sample-responsiveness");
		await waitUntil(() => existsSync(join(state, "metrics.json")), "baseline measured");
		const baseline = JSON.parse(readFileSync(join(state, "metrics.json"), "utf8"));
		for (let copy = 0; copy < copies; copy++) {
			runInPane(parent, `INTEGRATION_VISUAL_PARENT. Call the replicate tool once with name: "active-copy-${copy}" task: "Use replication_probe then Return exactly REPLICATION_SUMMARY"`);
			await waitUntil(() => entries(parentFile).filter(row => row.message?.toolName === "replicate").length === copy + 1, "replica launch saved");
			await waitForScreen(parent, /REPLICATION_PARENT_WAITING/, PI_TIMEOUT);
		}
		await waitUntil(() => readdirSync(state).filter(file => file.startsWith("active-")).length === copies, "all child tools active");
		const sessionDir = JSON.parse(readFileSync(join(state, "runtime.json"), "utf8")).sessionDir;
		for (let index = 0; index < 20; index++) {
			const id = `historical-${index}`;
			const file = join(sessionDir, `${id}.jsonl`);
			const lineage = registerLineage({ artifactDir: join(sessionDir, "artifacts", id), nodeId: id, parentSessionId: id });
			writeFileSync(file, JSON.stringify({ type: "session", id }) + "\n" + JSON.stringify({ type: "custom", data: "x".repeat(512 * 1024) }) + "\n");
			writeFileSync(`${file}.lineage.json`, JSON.stringify(lineage));
		}
		await sleep(2200); // Warm the new session tails before measuring repeated work.
		writeFileSync(join(state, "metrics.json"), "null");
		runInPane(parent, "/sample-responsiveness");
		await waitUntil(() => JSON.parse(readFileSync(join(state, "metrics.json"), "utf8")) !== null, "active supervision measured");
		const active = JSON.parse(readFileSync(join(state, "metrics.json"), "utf8"));
		console.log(JSON.stringify({ copies, baseline, active }));
		// An idle supervision window must not repeatedly consume multi-MiB histories.
		assert.ok(active.bytes < 2 * 1024 * 1024, `repeated supervision read ${active.bytes} bytes`);
		const inputAt = performance.now();
		runInPane(parent, "Use bash: echo 'PARENT_TOOL_DURING_REPLICATION'\nThen Return exactly PARENT_STILL_RESPONSIVE");
		await waitUntil(() => entries(parentFile).some(row => row.message?.role === "assistant" && JSON.stringify(row.message.content).includes("PARENT_STILL_RESPONSIVE")), "parent handles input before children finish");
		console.log(JSON.stringify({ copies, inputToAnswerMs: performance.now() - inputAt }));
		assert.ok(entries(parentFile).some(row => row.message?.role === "toolResult" && row.message.toolName === "bash" && JSON.stringify(row.message.content).includes("PARENT_TOOL_DURING_REPLICATION")), "the parent tool runs before replica completion");
		assert.equal(existsSync(join(state, "release")), false);
		writeFileSync(join(state, "release"), "release");
		await waitUntil(() => entries(parentFile).filter(row => row.customType === "subagent_result").length === copies, "all copies deliver exactly once");
		await sleep(1200);
		assert.equal(entries(parentFile).filter(row => row.customType === "subagent_result").length, copies);
	});
});
