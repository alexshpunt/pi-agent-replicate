import assert from "node:assert/strict";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { getProviderRequests, resetProviderRequests } from "./fake-provider.ts";
import { cleanupTestEnv, createTestEnv, createTrackedSurface, getAvailableBackends, interruptPane, readPaneAsync, runInPane, shellQuote, sleep, startPi, waitForPaneReady, waitForScreen, type TestEnv } from "./harness.ts";
import { childSessionLocation, readSessionBinding, sessionLocationAlive } from "../../pi-extension/subagents/session-binding.ts";

function entries(path: string): any[] {
	return existsSync(path) ? readFileSync(path, "utf8").trim().split("\n").filter(Boolean).map(line => JSON.parse(line)) : [];
}
async function until(check: () => boolean, message: string): Promise<void> {
	const deadline = Date.now() + 90_000;
	while (Date.now() < deadline) {
		if (check()) return;
		await sleep(50);
	}
	assert.fail(message);
}

for (const backend of getAvailableBackends()) {
	describe(`replica stops (${backend})`, { timeout: 360_000 }, () => {
		let env: TestEnv;
		beforeEach(() => { resetProviderRequests(); env = createTestEnv(backend, { replication: true }); });
		afterEach(async () => {
			const artifacts = process.env.PI_INTEGRATION_DEBUG_ARTIFACT_DIR;
			if (artifacts) {
				mkdirSync(artifacts, { recursive: true });
				const parent = entries(join(env.dir, "parent.jsonl"));
				const launched = parent.find(row => row.message?.toolName === "replicate")?.message.details;
				const sessionFile = launched?.sessionFile;
				const binding = sessionFile && readSessionBinding(sessionFile);
				const location = binding?.child && childSessionLocation(binding.child.lineage.rootDir, binding.child.lineage.nodeId);
				const read = (path: string) => { try { return readFileSync(path, "utf8"); } catch { return null; } };
				writeFileSync(join(artifacts, env.dir.split("/").at(-1)! + ".json"), JSON.stringify({
					parent, child: sessionFile && entries(sessionFile), location,
					parentScreen: env.surfaces[0] ? await readPaneAsync(env.surfaces[0], 80).catch(String) : null,
					deliveryLog: sessionFile && read(join(sessionFile, "..", "subagent-delivery.log")),
					lineage: binding?.child && readdirSync(join(binding.child.lineage.rootDir, "events")).map(file => read(join(binding.child!.lineage.rootDir, "events", file))),
					exit: sessionFile && read(sessionFile + ".exit"), stop: sessionFile && read(sessionFile + ".replica-stop"),
					work: launched && read(join(env.dir, ".pi", "agent", "subagent-sessions", "replicas", launched.id + ".json")),
					screen: location?.paneId ? await readPaneAsync(location.paneId, 80).catch(String) : null,
				}));
			}
			await cleanupTestEnv(env);
		});

		for (const action of ["message", "escape"]) {
			it(`returns and closes after user ${action}`, async () => {
				const parentFile = join(env.dir, "parent.jsonl"), gate = join(env.dir, "release");
				const parent = createTrackedSurface(env, "stop-parent");
				await waitForPaneReady(parent);
				startPi(parent, env.dir, "Return exactly STOP_PARENT_READY", { extraArgs: `--session ${shellQuote(parentFile)}` });
				await until(() => entries(parentFile).some(row => row.message?.role === "assistant"), "parent ready");
				runInPane(parent, `Call the replicate tool once with task: ${JSON.stringify(`INTEGRATION_WAIT_FOR_FILE: ${gate} Return exactly STOP_CHILD_SUMMARY`)}`);
				await until(() => entries(parentFile).some(row => row.message?.toolName === "replicate"), "replica launched");
				const launched = entries(parentFile).find(row => row.message?.toolName === "replicate").message.details;
				const binding = readSessionBinding(launched.sessionFile)!;
				await until(() => !!childSessionLocation(binding.child!.lineage.rootDir, binding.child!.lineage.nodeId), "child binds its live location");
				const location = childSessionLocation(binding.child!.lineage.rootDir, binding.child!.lineage.nodeId)!;
				await until(() => getProviderRequests().some(request => request.userText.includes("Your assignment:") && request.userText.includes("STOP_CHILD_SUMMARY")), "child streaming its assignment");
				if (action === "message") {
					runInPane(location.paneId!, "Return exactly USER_CHANGED_SUMMARY");
					await waitForScreen(location.paneId!, /(?:Steering|Follow-up): Return exactly USER_CHANGED_SUMMARY/, 10_000);
					writeFileSync(gate, "release");
					await until(() => entries(launched.sessionFile).some(row => row.message?.role === "user" && JSON.stringify(row.message.content).includes("USER_CHANGED_SUMMARY")), "queued user input saved");
				} else interruptPane(location.paneId!);
				await until(() => entries(parentFile).some(row => row.customType === "subagent_result"), "stopped replica must report");
				const results = entries(parentFile).filter(row => row.customType === "subagent_result");
				assert.equal(results.length, 1);
				if (action === "message") {
					assert.match(results[0].content, /USER_CHANGED_SUMMARY/);
					assert.equal(results[0].details.exitCode, 0);
				} else {
					assert.match(results[0].content, /interrupt|abort/i);
					assert.equal(results[0].details.exitCode, 1);
					assert.equal(results[0].details.integration.status, "not-attempted");
					assert.ok(existsSync(results[0].details.historyPath));
				}
				await until(() => !sessionLocationAlive(location), "reported replica must exit");
			});
		}

		for (const reload of [false, true]) {
			it(`retries a missed completion ${reload ? "across reload" : "after ten stopped seconds"} without restarting the model`, async () => {
				const parentFile = join(env.dir, "parent.jsonl"), blocker = join(env.dir, "blocked-path"), capability = join(env.dir, "block-completion.ts");
				writeFileSync(capability, `import {mkdirSync,writeFileSync} from 'node:fs'; export default function(pi){if(process.env.PI_SUBAGENT_REPLICATION==='1'){pi.on('agent_end',()=>{const p=process.env.PI_SUBAGENT_SESSION+'.exit';mkdirSync(p,{recursive:true});writeFileSync(${JSON.stringify(blocker)},p);});}}`);
				const parent = createTrackedSurface(env, "safety-parent");
				await waitForPaneReady(parent);
				startPi(parent, env.dir, "Return exactly SAFETY_PARENT_READY", { extraArgs: `--session ${shellQuote(parentFile)} -e ${shellQuote(capability)}` });
				await until(() => entries(parentFile).some(row => row.message?.role === "assistant"), "parent ready");
				runInPane(parent, 'Call the replicate tool once with task: "Return exactly SAFETY_CHILD_SUMMARY"');
				await until(() => existsSync(blocker), "fault blocks normal completion publication");
				const path = readFileSync(blocker, "utf8");
				await until(() => entries(path.slice(0, -5)).some(row => row.message?.role === "assistant" && JSON.stringify(row.message.content).includes("SAFETY_CHILD_SUMMARY")), "final answer saved");
				await until(() => existsSync(path.slice(0, -5) + ".replica-stop"), "fully settled evidence saved despite failed completion publication");
				const stoppedAt = JSON.parse(readFileSync(path.slice(0, -5) + ".replica-stop", "utf8")).stoppedAt;
				if (reload) {
					const binding = readSessionBinding(path.slice(0, -5))!;
					const location = childSessionLocation(binding.child!.lineage.rootDir, binding.child!.lineage.nodeId)!;
					runInPane(location.paneId!, "/reload");
					await waitForScreen(location.paneId!, /Reloaded keybindings, extensions/, 30_000);
				}
				rmSync(path, { recursive: true });
				await until(() => entries(parentFile).some(row => row.customType === "subagent_result"), "ten-second safety net must return the saved settlement");
				const results = entries(parentFile).filter(row => row.customType === "subagent_result");
				assert.equal(results.length, 1);
				assert.match(results[0].content, /SAFETY_CHILD_SUMMARY/);
				if (!reload) assert.ok(Date.now() - stoppedAt >= 10_000, "the fallback does not fire before ten stopped seconds");
				assert.equal(results[0].details.exitCode, 0);
				assert.equal(getProviderRequests().filter(request => request.userText.includes("Your assignment:") && request.userText.includes("SAFETY_CHILD_SUMMARY")).length, 1, "no automatic relaunch");
				const binding = readSessionBinding(path.slice(0, -5))!;
				const location = childSessionLocation(binding.child!.lineage.rootDir, binding.child!.lineage.nodeId)!;
				await until(() => !sessionLocationAlive(location), "recovered completion closes the replica process");
			});
		}
	});
}
