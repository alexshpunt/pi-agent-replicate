import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { reduceLineage } from "../../pi-extension/subagents/lineage.ts";
import { childSessionLocation, sessionLocationAlive } from "../../pi-extension/subagents/session-binding.ts";
import { getProviderRequests, resetProviderRequests } from "./fake-provider.ts";
import { cleanupTestEnv, closePane, createTestEnv, createTrackedSurface, getAvailableBackends, PI_TIMEOUT, runInPane, shellQuote, sleep, startPi, waitForPaneAbsence, waitForPaneReady, type TestEnv } from "./harness.ts";

function records(file: string): any[] {
	if (!existsSync(file)) return [];
	const text = readFileSync(file, "utf8");
	return text.slice(0, text.lastIndexOf("\n") + 1).split("\n").filter(Boolean).map(line => JSON.parse(line));
}
async function until(check: () => boolean, reason: string): Promise<void> {
	const deadline = Date.now() + PI_TIMEOUT;
	while (Date.now() < deadline) { if (check()) return; await sleep(50); }
	assert.fail(reason);
}

for (const backend of getAvailableBackends()) {
	describe(`retained child manual close (${backend})`, { timeout: PI_TIMEOUT * 3 }, () => {
		let env: TestEnv;
		beforeEach(() => { resetProviderRequests(); env = createTestEnv(backend); });
		afterEach(async () => { await cleanupTestEnv(env); });

		it("cancels a manually closed child once without attempting recovery", async () => {
			const original = join(env.dir, "manual-close-parent.jsonl");
			const witness = join(env.dir, "manual-close-launch.json");
			const parentIdle = join(env.dir, "parent-idle-after-result");
			const bridge = join(env.dir, "manual-close-fixture.ts");
			const source = new URL("../../pi-extension/subagents/index.ts", import.meta.url).pathname;
			// Exercise the retained launcher internally without registering a model-facing tool.
			writeFileSync(bridge, `import {__test__} from ${JSON.stringify(source)};import {appendFileSync,existsSync,writeFileSync} from 'node:fs';
export default function(pi){pi.on('session_start',async (_event,ctx)=>{if(process.env.PI_SUBAGENT_ID)return;const file=${JSON.stringify(witness)};if(!existsSync(file)){const running=await __test__.launchSubagent({name:'manual-close-child',task:'INTEGRATION_HOLD_QUIET_ONCE'},ctx,pi.getThinkingLevel());__test__.startRecoveredWatcher(running);writeFileSync(file,JSON.stringify({id:running.id,sessionFile:running.sessionFile,rootDir:running.lineage.rootDir}));}appendFileSync(file+'.starts','start\\n');});pi.on('agent_end',(_event,ctx)=>{if(process.env.PI_SUBAGENT_ID||!ctx.sessionManager.getBranch().some(e=>e.type==='custom_message'&&e.customType==='subagent_result'))return;const timer=setInterval(()=>{if(ctx.isIdle()){writeFileSync(${JSON.stringify(parentIdle)},'idle');clearInterval(timer);}},20);timer.unref();});}`);
			const parent = createTrackedSurface(env, "manual-close-parent");
			await waitForPaneReady(parent);
			startPi(parent, env.dir, "Return exactly MANUAL_CLOSE_PARENT_READY", {
				extraArgs: `--session ${shellQuote(original)} -e ${shellQuote(bridge)}`,
				environment: { PI_SUBAGENT_QUIET_THRESHOLD_MS: "30000" },
			});
			await until(() => existsSync(witness) && records(original).some(row => row.message?.role === "assistant"), "parent and retained child launched");
			const launched = JSON.parse(readFileSync(witness, "utf8"));
			const location = () => childSessionLocation(launched.rootDir, launched.id);
			await until(() => !!location()?.paneId && sessionLocationAlive(location()!) && getProviderRequests().some(request => request.userText.includes("INTEGRATION_HOLD_QUIET_ONCE")), "retained child is running its request");
			const childPane = location()!.paneId!;
			closePane(childPane);
			await waitForPaneAbsence(childPane);
			const results = () => records(original).filter(row => row.customType === "subagent_result");
			await until(() => results().length === 1, "the original parent receives the cancellation");
			const result = results()[0];
			assert.equal(result.details.childId, launched.id);
			assert.equal(result.details.sessionFile, launched.sessionFile);
			assert.equal(result.details.deliveryId, `terminal:${launched.id}`);
			assert.match(result.details.resultPath, /-cancelled\.md$/);
			assert.ok(existsSync(result.details.resultPath));
			await until(() => !!reduceLineage(launched.rootDir).nodes.get(launched.id)?.terminalDelivered, "cancellation delivery is durable");
			const node = reduceLineage(launched.rootDir).nodes.get(launched.id)!;
			assert.equal(node.cancellation?.intent, true);
			assert.equal(node.cancellation?.proven, true);
			const events = readdirSync(join(launched.rootDir, "events")).filter(file => file.endsWith(".json")).map(file => JSON.parse(readFileSync(join(launched.rootDir, "events", file), "utf8")));
			assert.ok(events.some(event => event.nodeId === launched.id && event.type === "cancel_intent" && event.source === "user_tab_close"));
			const ledger = () => records(join(launched.rootDir, "subagent-delivery.log"));
			assert.equal(ledger().filter(event => event.childId === launched.id && event.event === "recovery-attempt").length, 0);
			await until(() => existsSync(parentIdle), "parent finishes responding to the cancellation before reload");
			// Reload restoration must neither replay the cancellation nor start a recovery.
			runInPane(parent, "/reload");
			await until(() => existsSync(witness + ".starts") && readFileSync(witness + ".starts", "utf8").trim().split("\n").length === 2, "parent reload finishes");
			await sleep(1200);
			assert.equal(results().length, 1);
			assert.equal(ledger().filter(event => event.childId === launched.id && event.event === "recovery-attempt").length, 0);
		});
	});
}
