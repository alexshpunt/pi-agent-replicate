import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { it } from "node:test";
import { reduceLineage } from "../../pi-extension/subagents/lineage.ts";
import { childSessionLocation, readSessionBinding, sessionLineageRoots, sessionLocationAlive } from "../../pi-extension/subagents/session-binding.ts";
import { getProviderRequests, resetProviderRequests } from "./fake-provider.ts";
import { cleanupTestEnv, createTestEnv, createTrackedSurface, getAvailableBackends, PI_TIMEOUT, readPaneAsync, runInPane, shellQuote, sleep, startPi, waitForPaneReady } from "./harness.ts";

function entries(file: string): any[] {
	if (!existsSync(file)) return [];
	const source = readFileSync(file, "utf8");
	return source.slice(0, source.lastIndexOf("\n") + 1).trim().split("\n").filter(Boolean).map(line => JSON.parse(line));
}
function results(file: string): any[] { return entries(file).filter(row => row.customType === "subagent_result"); }
async function until(check: () => boolean, reason: string): Promise<void> {
	const deadline = Date.now() + PI_TIMEOUT;
	while (Date.now() < deadline) { if (check()) return; await sleep(50); }
	assert.ok(check(), reason);
}

for (const backend of getAvailableBackends()) {
	for (const blocked of [false, true]) {
		it(`returns the continuation after a replica ${blocked ? "gets a blocked reload" : "schedules its own reload"} (${backend})`, { timeout: PI_TIMEOUT * 2 }, async () => {
			resetProviderRequests();
			const env = createTestEnv(backend, { replication: true });
			const original = join(env.dir, "self-reload-parent.jsonl");
			const probe = new URL("./fixtures/reload-probe.ts", import.meta.url).pathname;
			const parent = createTrackedSurface(env, "self-reload-parent");
			try {
				await waitForPaneReady(parent);
				startPi(parent, env.dir, "Return exactly SELF_RELOAD_PARENT_READY", { extraArgs: `--session ${shellQuote(original)} -e ${shellQuote(probe)}` });
				await until(() => entries(original).some(row => row.message?.role === "assistant"), "parent ready");
				runInPane(parent, `Call the replicate tool once with name: "self-reload-owner", task: "SELF_RELOAD_OWNER${blocked ? " BLOCK_RELOAD" : ""}"`);
				await until(() => results(original).length === 1, "self-reloaded replica returns");
				const result = results(original)[0];
				assert.equal(result.details.exitCode, 0, result.content);
				assert.match(result.content, blocked ? /REPLICA_AFTER_BLOCKED/ : /REPLICA_AFTER_RELOAD/, "the pre-reload acknowledgement is not the final assignment result");
				assert.doesNotMatch(result.content, /REPLICA_RELOAD_SCHEDULED/);
				assert.equal(result.details.integration.status, "applied");
				assert.equal(entries(result.details.sessionFile).filter(row => row.message?.toolName === "pi_extension_dev_reload_self").length, 1);
				assert.equal(results(original).length, 1);
			} finally { await cleanupTestEnv(env); }
		});
	}
	for (const [reloadParent, startupProbe] of [[false, false], [true, false], [true, true]]) {
		it(`returns a reloaded replica after its descendant drains${reloadParent ? " with parent reload" : ""}${startupProbe ? " and startup probe" : ""} (${backend})`, { timeout: PI_TIMEOUT * 3 }, async () => {
			resetProviderRequests();
			const env = createTestEnv(backend, { replication: true });
			const original = join(env.dir, "reload-parent.jsonl");
			const gate = join(env.dir, ".pi", "agent", "reload-descendant-release");
			const witness = join(env.dir, ".pi", "agent", "reload-starts.json");
			const capability = join(env.dir, "reload-capability.ts");
			const typebox = new URL("../../node_modules/@sinclair/typebox/build/esm/index.mjs", import.meta.url).pathname;
			const probe = new URL("./fixtures/reload-probe.ts", import.meta.url).pathname;
			writeFileSync(capability, `import {Type} from ${JSON.stringify(typebox)};import {existsSync,readFileSync,rmSync,writeFileSync} from 'node:fs';import {join} from 'node:path';
export default function(pi){
 pi.on('session_start',(_event,ctx)=>{const file=${JSON.stringify(witness)};const all=existsSync(file)?JSON.parse(readFileSync(file,'utf8')):{};const id=ctx.sessionManager.getSessionId();all[id]={starts:(all[id]?.starts??0)+1,pid:process.pid};writeFileSync(file,JSON.stringify(all));});
 pi.on('session_shutdown',async event=>{const armed=${JSON.stringify(witness + '.hold')};if(process.env.PI_SUBAGENT_ID||event.reason!=='reload'||!existsSync(armed))return;const owner=readFileSync(armed,'utf8');rmSync(armed);writeFileSync(${JSON.stringify(gate)},'release');const end=Date.now()+15000;while(!existsSync(owner+'.exit')&&Date.now()<end)await new Promise(resolve=>setTimeout(resolve,25));if(!existsSync(owner+'.exit'))throw Error('owner did not finish during parent reload');writeFileSync(${JSON.stringify(witness + '.completed-during-reload')},owner);});
 pi.registerTool({name:'replication_probe',label:'Probe',description:'Save descendant source',parameters:Type.Object({}),async execute(){writeFileSync(join(process.cwd(),'descendant.txt'),'RELOADED_DESCENDANT_SOURCE');return {content:[{type:'text',text:'source saved'}],details:{}};}});
}
`);
			const parent = createTrackedSurface(env, "reload-parent");
			let ownerFile: string | undefined;
			let descendantFile: string | undefined;
			try {
				await waitForPaneReady(parent);
				startPi(parent, env.dir, "Return exactly RELOAD_PARENT_READY", { extraArgs: `--session ${shellQuote(original)} -e ${shellQuote(capability)} ${startupProbe ? `-e ${shellQuote(probe)}` : ""}` });
				await until(() => entries(original).some(row => row.message?.role === "assistant"), "parent ready");
				runInPane(parent, `Call the replicate tool once with name: "reload-owner", task: "REPLICATION_NESTED_OWNER INTEGRATION_DESCENDANT_GATE: ${gate}"`);
				const nodes = () => {
					const binding = readSessionBinding(original);
					return binding ? sessionLineageRoots(binding.storeDir, binding.sessionId).flatMap(root => [...reduceLineage(root).nodes.values()]) : [];
				};
				await until(() => nodes().filter(node => node.replication).length === 2, "owner launches one descendant");
				const owner = nodes().find(node => node.replication && !node.parentNodeId)!;
				const descendant = nodes().find(node => node.parentNodeId === owner.nodeId)!;
				ownerFile = owner.sessionFile!;
				descendantFile = descendant.sessionFile!;
				await until(() => entries(ownerFile!).some(row => row.message?.role === "assistant" && JSON.stringify(row.message.content).includes("REPLICATION_OWNER_WAITING")), "owner settles while waiting for its child");
				const binding = readSessionBinding(ownerFile)!;
				const location = () => childSessionLocation(binding.child!.lineage.rootDir, owner.nodeId)!;
				const before = location();
				const starts = () => JSON.parse(readFileSync(witness, "utf8"));
				runInPane(before.paneId!, startupProbe ? "/reload-probe" : "/reload");
				await until(() => starts()[before.sessionId]?.starts === 2, "replica runtime reloaded");
				if (startupProbe) {
					const checked = JSON.parse(readFileSync(join(env.dir, ".pi", "agent", "reload-probe-result.json"), "utf8"));
					assert.equal(checked.foreignCompletion, false, "a no-session startup check cannot publish completion for the live replica");
				}
				assert.equal(location().pid, before.pid, "reload keeps the same process");
				assert.equal(location().sessionId, before.sessionId);
				assert.equal(results(original).length, 0, "reload cannot settle an owner with pending descendants");
				if (reloadParent) {
					const id = entries(original)[0].id;
					writeFileSync(witness + ".hold", ownerFile);
					runInPane(parent, "/reload");
					await until(() => starts()[id]?.starts === 2, "parent runtime reloaded");
					assert.equal(readFileSync(witness + ".completed-during-reload", "utf8"), ownerFile, "the result is saved before parent restoration");
				}
				writeFileSync(gate, "release");
				await until(() => results(original).length === 1, "owner result reaches the original parent");
				const result = results(original)[0];
				assert.equal(result.details.exitCode, 0, result.content);
				assert.match(result.content, /REPLICATION_NESTED_SUMMARY/);
				assert.equal(result.details.integration.status, "applied");
				assert.equal(results(ownerFile).length, 1, "descendant returns once to its immediate parent");
				assert.equal(results(ownerFile)[0].details.childId, descendant.nodeId);
				assert.equal(readFileSync(join(env.dir, "descendant.txt"), "utf8"), "RELOADED_DESCENDANT_SOURCE");
				assert.equal(entries(ownerFile).filter(row => row.message?.role === "user" && JSON.stringify(row.message.content).includes("Your assignment:")).length, 1);
				assert.equal(getProviderRequests().filter(request => request.userText.includes("Your assignment:\nREPLICATION_NESTED_OWNER") && request.messages.at(-1)?.role !== "tool").length, 1, "reload does not repeat the assignment");
				await until(() => !sessionLocationAlive(location()), "settled owner closes");
				const parentId = entries(original)[0].id;
				const count = starts()[parentId].starts;
				runInPane(parent, "/reload");
				await until(() => starts()[parentId]?.starts === count + 1, "final parent reload completes");
				assert.equal(results(original).length, 1, "later reload does not redeliver the owner");
			} catch (error) {
				const report = { error: String(error), parent: entries(original), owner: ownerFile && entries(ownerFile), descendant: descendantFile && entries(descendantFile), screen: await readPaneAsync(parent, 100), requests: getProviderRequests() };
				const artifacts = process.env.PI_INTEGRATION_DEBUG_ARTIFACT_DIR;
				if (artifacts) { mkdirSync(artifacts, { recursive: true }); writeFileSync(join(artifacts, `replica-reload-${reloadParent}.json`), JSON.stringify(report)); }
				assert.fail(`${error}\n${report.screen}`);
			} finally {
				writeFileSync(gate, "release");
				await cleanupTestEnv(env);
			}
		});
	}
}
