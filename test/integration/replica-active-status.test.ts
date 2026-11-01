import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { childSessionLocation, readSessionBinding, sessionLocationAlive } from "../../pi-extension/subagents/session-binding.ts";
import { cleanupTestEnv, createTestEnv, createTrackedSurface, getAvailableBackends, PI_TIMEOUT, readPane, runInPane, shellQuote, sleep, startPi, waitForPaneReady, type TestEnv } from "./harness.ts";

function entries(file: string): any[] {
	if (!existsSync(file)) return [];
	const source = readFileSync(file, "utf8");
	return source.slice(0, source.lastIndexOf("\n") + 1).split("\n").filter(Boolean).map(line => JSON.parse(line));
}
async function until(check: () => boolean, explanation: string): Promise<void> {
	const deadline = Date.now() + PI_TIMEOUT;
	while (Date.now() < deadline) { if (check()) return; await sleep(50); }
	assert.fail(explanation);
}

for (const backend of getAvailableBackends()) {
	describe(`replica active status (${backend})`, { timeout: PI_TIMEOUT * 2 }, () => {
		let env: TestEnv;
		beforeEach(() => { env = createTestEnv(backend, { replication: true }); });
		afterEach(async () => { await cleanupTestEnv(env); });

		it("keeps a replica active throughout a long-running tool call", async () => {
			const parentFile = join(env.dir, "active-status-parent.jsonl");
			const state = join(env.dir, ".pi", "agent", "active-status"); mkdirSync(state);
			const release = join(state, "release"), started = join(state, "started"), samples = join(state, "samples.jsonl");
			const capability = join(env.dir, "active-status-capability.ts");
			const typebox = new URL("../../node_modules/@sinclair/typebox/build/esm/index.mjs", import.meta.url).pathname;
			const extension = new URL("../../pi-extension/subagents/index.ts", import.meta.url).pathname;
			writeFileSync(capability, `import {Type} from ${JSON.stringify(typebox)};
import {appendFileSync,existsSync,writeFileSync} from 'node:fs';
import {__test__} from ${JSON.stringify(extension)};
export default function(pi) {
 let timer;
 pi.on('session_start', () => { if (process.env.PI_SUBAGENT_SESSION) return; timer=setInterval(() => {
   for (const child of __test__.runningSubagents.values()) appendFileSync(${JSON.stringify(samples)},JSON.stringify({at:Date.now(),id:child.id,kind:child.lastProjectedKind,toolActive:child.activity?.toolActive,activeSince:child.activity?.activeSince})+'\\n');
 },100); });
 pi.on('session_shutdown', () => { if(timer) clearInterval(timer); });
 pi.registerTool({name:'replication_probe',label:'Probe',description:'Hold a real active tool',parameters:Type.Object({}),async execute() {
   writeFileSync(${JSON.stringify(started)},'ready');
   const deadline=Date.now()+60000;
   while(!existsSync(${JSON.stringify(release)})) { if(Date.now()>deadline) throw Error('release timed out'); await new Promise(resolve=>setTimeout(resolve,25)); }
   return {content:[{type:'text',text:'probe complete'}],details:{}};
 }});
}`);
			const parent = createTrackedSurface(env, "active-status-parent");
			await waitForPaneReady(parent);
			startPi(parent, env.dir, "Return exactly STATUS_PARENT_READY", {
				extraArgs: `--session ${shellQuote(parentFile)} -e ${shellQuote(capability)}`,
				environment: { PI_SUBAGENT_QUIET_THRESHOLD_MS: "250" },
			});
			try {
				await until(() => entries(parentFile).some(row => row.message?.role === "assistant"), "parent ready");
				runInPane(parent, 'INTEGRATION_VISUAL_PARENT. Call the replicate tool once with name: "active-status-copy" task: "Use replication_probe then Return exactly ACTIVE_STATUS_SUMMARY"');
				await until(() => existsSync(started) && entries(parentFile).some(row => row.message?.toolName === "replicate"), "replica tool is running");
				const launch = entries(parentFile).find(row => row.message?.toolName === "replicate").message.details;
				const binding = readSessionBinding(launch.sessionFile)!;
				const location = () => childSessionLocation(binding.child!.lineage.rootDir, binding.child!.lineage.nodeId);
				await until(() => {
					const observed = entries(samples).filter(row => row.id === launch.id && row.kind === "active" && row.toolActive && Number.isFinite(row.activeSince));
					return observed.length >= 2 && observed.at(-1).at - observed[0].activeSince > 2_500;
				}, "parent observes the active tool past multiple watchdog cycles");
				const observed = entries(samples).filter(row => row.id === launch.id && row.kind);
				assert.ok(observed.some(row => row.kind === "active" && row.toolActive));
				assert.ok(observed.every(row => row.kind !== "stalled"), "active work must never project a stalled status");
				assert.ok(sessionLocationAlive(location()!), "the original replica remains alive while the tool runs");
				assert.equal(entries(parentFile).filter(row => row.customType === "subagent_result").length, 0);
				writeFileSync(release, "release");
				await until(() => entries(parentFile).filter(row => row.customType === "subagent_result").length === 1, "replica result delivered");
				const result = entries(parentFile).find(row => row.customType === "subagent_result");
				assert.equal(result.details.childId, launch.id);
				assert.equal(result.details.exitCode, 0);
				assert.equal(result.details.integration.status, "applied");
			} catch (error) {
				assert.fail(`${error}\n${readPane(parent, 100)}`);
			} finally {
				writeFileSync(release, "release");
			}
		});
	});
}
