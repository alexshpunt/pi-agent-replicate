import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { childSessionLocation, sessionLocationAlive } from "../../pi-extension/subagents/session-binding.ts";
import { getProviderRequests, resetProviderRequests } from "./fake-provider.ts";
import { cleanupTestEnv, createTestEnv, createTrackedSurface, getAvailableBackends, PI_TIMEOUT, runInPane, shellQuote, sleep, startPi, waitForPaneReady, type TestEnv } from "./harness.ts";

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
	describe(`retained child recovery (${backend})`, { timeout: PI_TIMEOUT * 5 }, () => {
		let env: TestEnv;
		beforeEach(() => { resetProviderRequests(); env = createTestEnv(backend); });
		afterEach(async () => { await cleanupTestEnv(env); });

		for (const cause of ["crash", "stale"] as const) {
			it(`recovers a retained child after ${cause}`, { timeout: PI_TIMEOUT * 2 }, async () => {
				const original = join(env.dir, "recovery-parent.jsonl");
				const witness = join(env.dir, "retained-launch.json");
				const bridge = join(env.dir, "retained-launch-fixture.ts");
				const source = new URL("../../pi-extension/subagents/index.ts", import.meta.url).pathname;
				const task = cause === "crash" ? "INTEGRATION_HOLD_QUIET_ONCE" : "INTEGRATION_ALWAYS_QUIET";
				// This test-only session hook calls the retained internal launcher, not a model-facing tool.
				writeFileSync(bridge, `import {__test__} from ${JSON.stringify(source)};import {appendFileSync,existsSync,writeFileSync} from 'node:fs';
export default function(pi){pi.on('session_start',async (_event,ctx)=>{if(process.env.PI_SUBAGENT_ID)return;const file=${JSON.stringify(witness)};if(!existsSync(file)){const running=await __test__.launchSubagent({name:'retained-recovery',task:${JSON.stringify(task)}},ctx,pi.getThinkingLevel());__test__.startRecoveredWatcher(running);writeFileSync(file,JSON.stringify({id:running.id,sessionFile:running.sessionFile,rootDir:running.lineage.rootDir}));}appendFileSync(file+'.starts','start\\n');});}`);
				const parent = createTrackedSurface(env, `retained-${cause}`);
				await waitForPaneReady(parent);
				startPi(parent, env.dir, "Return exactly RETAINED_PARENT_READY", {
					extraArgs: `--session ${shellQuote(original)} -e ${shellQuote(bridge)}`,
					environment: { PI_SUBAGENT_QUIET_THRESHOLD_MS: cause === "stale" ? "250" : "30000" },
				});
				await until(() => existsSync(witness) && records(original).some(row => row.message?.role === "assistant"), "parent and retained child launched");
				const launched = JSON.parse(readFileSync(witness, "utf8"));
				const location = () => childSessionLocation(launched.rootDir, launched.id);
				await until(() => !!location()?.pid && sessionLocationAlive(location()!) && getProviderRequests().some(request => request.userText.includes(task)), "retained child is active");
				const initial = location()!;
				// The production startup path restores status supervision on reload.
				runInPane(parent, "/reload");
				await until(() => existsSync(witness + ".starts") && readFileSync(witness + ".starts", "utf8").trim().split("\n").length === 2, "parent reload restores supervision");
				if (cause === "crash") process.kill(initial.pid!, "SIGKILL");
				const results = () => records(original).filter(row => row.customType === "subagent_result");
				await until(() => results().length === 1, "the original parent receives one terminal result");
				const result = results()[0];
				assert.equal(result.details.childId, launched.id);
				assert.equal(result.details.sessionFile, launched.sessionFile);
				const ledger = records(join(launched.rootDir, "subagent-delivery.log"));
				const attempts = ledger.filter(event => event.event === "recovery-attempt" && event.childId === launched.id);
				assert.equal(attempts.length, cause === "crash" ? 1 : 3);
				assert.ok(attempts.every(event => event.cause === cause));
				assert.deepEqual(attempts.map(event => event.attempt), cause === "crash" ? [1] : [1, 2, 3]);
				if (cause === "crash") {
					assert.equal(result.details.exitCode, 0);
					assert.match(result.details.resultContent, /QUIET_RECOVERY_COMPLETE/);
					assert.equal(ledger.filter(event => event.event === "recovery-resumed" && event.childId === launched.id).length, 1);
				} else {
					assert.equal(result.details.exitCode, 1);
					assert.ok(existsSync(result.details.resultPath));
					assert.equal(ledger.filter(event => event.event === "recovery-resumed" && event.childId === launched.id).length, 3);
					const events = readdirSync(join(launched.rootDir, "events")).filter(file => file.endsWith(".json")).map(file => JSON.parse(readFileSync(join(launched.rootDir, "events", file), "utf8")));
					assert.ok(!events.some(event => event.source === "user_tab_close"));
				}
				await sleep(1200);
				assert.equal(results().length, 1, "the terminal result is not redelivered");
			});
		}
	});
}
