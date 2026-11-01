import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { it } from "node:test";
import { getProviderRequests, resetProviderRequests } from "./fake-provider.ts";
import { readSessionBinding, childSessionLocation } from "../../pi-extension/subagents/session-binding.ts";
import { readReplicaWork } from "../../pi-extension/subagents/replica-work.ts";
import { cleanupTestEnv, createTestEnv, createTrackedSurface, getAvailableBackends, runInPane, readPaneAsync, shellQuote, sleep, startPi, waitForPaneReady, waitForScreen, PI_TIMEOUT } from "./harness.ts";

function entries(file: string): any[] {
	if (!existsSync(file)) return [];
	const source = readFileSync(file, "utf8");
	return source.slice(0, source.lastIndexOf("\n") + 1).trim().split("\n").filter(Boolean).map(line => JSON.parse(line));
}
async function until(check: () => boolean, reason: string): Promise<void> {
	const end = Date.now() + PI_TIMEOUT;
	while (!check() && Date.now() < end) await sleep(50);
	assert.ok(check(), reason);
}

for (const backend of getAvailableBackends()) {
	it(`links out-of-order direct and deeply nested replica outcomes through reload (${backend})`, { timeout: PI_TIMEOUT * 4 }, async () => {
		resetProviderRequests();
		const env = createTestEnv(backend, { replication: true });
		const parentFile = join(env.dir, "output-parent.jsonl");
		const gate = join(env.dir, ".pi", "agent", "output-gates");
		mkdirSync(gate);
		const capability = join(env.dir, "output-capability.ts");
		const typebox = new URL("../../node_modules/@sinclair/typebox/build/esm/index.mjs", import.meta.url).pathname;
		writeFileSync(capability, `import {Type} from ${JSON.stringify(typebox)};
import {existsSync,readFileSync,writeFileSync} from 'node:fs';import {join} from 'node:path';
export default function(pi){
 if(process.env.PI_SUBAGENT_REPLICATION!=='1'){
 pi.on('agent_settled',(_event,ctx)=>{const branch=ctx.sessionManager.getBranch();writeFileSync(join(${JSON.stringify(gate)},'settled'),String(branch.filter(row=>row.type==='custom_message'&&row.customType==='subagent_result').length));writeFileSync(join(${JSON.stringify(gate)},'settled-launches'),String(branch.filter(row=>row.message?.role==='toolResult'&&['replicate','replication_output_wrapper'].includes(row.message.toolName)).length));});
 pi.on('session_shutdown',async event=>{const gate=${JSON.stringify(gate)};if(event.reason!=='reload'||existsSync(join(gate,'fast.release')))return;writeFileSync(join(gate,'fast.release'),'go');const child=readFileSync(join(gate,'fast.started'),'utf8');const end=Date.now()+15000;while(!existsSync(child+'.exit')&&Date.now()<end)await new Promise(resolve=>setTimeout(resolve,25));if(!existsSync(child+'.exit'))throw Error('fast copy did not complete during parent reload');writeFileSync(join(gate,'fast.completed-during-reload'),'saved');});
 }
 const parameters=Type.Object({name:Type.String(),task:Type.String()});
 for(const name of ['replication_output_wrapper','replication_output_inner'])pi.registerTool({name,label:name,description:'Exercise real nested replication',parameters,async execute(_id,args,signal,_update,ctx){const outcome=await ctx.executeTool(name==='replication_output_wrapper'?'replication_output_inner':'replicate',args,{signal});return {...outcome.result,isError:outcome.isError};}});
 pi.registerTool({name:'replication_probe',label:'Probe',description:'Hold this isolated copy',parameters:Type.Object({}),async execute(){
 const name=process.env.PI_SUBAGENT_NAME.includes('slow')?'slow':'fast';
 writeFileSync(join(${JSON.stringify(gate)},name+'.started'),process.env.PI_SUBAGENT_SESSION);
 const end=Date.now()+${PI_TIMEOUT * 2};while(!existsSync(join(${JSON.stringify(gate)},name+'.release'))&&Date.now()<end)await new Promise(r=>setTimeout(r,25));
 if(!existsSync(join(${JSON.stringify(gate)},name+'.release')))throw Error('gate timeout');
 return {content:[{type:'text',text:'released '+name}],details:{}};}});
}
`);
		const parent = createTrackedSurface(env, "output-parent");
		try {
			await waitForPaneReady(parent);
			startPi(parent, env.dir, "Return exactly OUTPUT_READY", { extraArgs: `--session ${shellQuote(parentFile)} -e ${shellQuote(capability)}` });
			try { await until(() => entries(parentFile).some(row => row.message?.role === "assistant"), "parent ready"); }
			catch (error) { assert.fail(`${error}\n${await readPaneAsync(parent, 100)}`); }
			runInPane(parent, 'Call the replicate tool once with name: "slow-check", task: "Use replication_probe then Return exactly SLOW_OUTPUT"');
			await until(() => existsSync(join(gate, "slow.started")), "direct copy started");
			runInPane(parent, 'Call the replica output wrapper with name: "fast-check", task: "Use replication_probe then Return exactly FAST_OUTPUT"');
			await until(() => existsSync(join(gate, "fast.started")), "nested copy started");
			const results = () => entries(parentFile).filter(row => row.customType === "subagent_result");
			await until(() => existsSync(join(gate, "settled-launches")) && readFileSync(join(gate, "settled-launches"), "utf8") === "2", "parent finishes both launch turns before reload");
			assert.equal(results().length, 0);
			runInPane(parent, "/reload");
			await waitForScreen(parent, /Reloaded keybindings, extensions/, PI_TIMEOUT);
			assert.ok(existsSync(join(gate, "fast.completed-during-reload")), "the fast result is saved while parent restoration is suspended");
			await until(() => results().length === 1, "fast result delivered first after parent restoration");
			assert.match(results()[0].content, /FAST_OUTPUT/);
			writeFileSync(join(gate, "slow.release"), "go");
			await until(() => results().length === 2, "slow result recovered after reload");
			const rows = entries(parentFile);
			for (const result of results()) {
				const nested = result.content.includes("FAST_OUTPUT");
				const call = rows.find(row => row.message?.role === "toolResult" && row.message.toolName === (nested ? "replication_output_wrapper" : "replicate"));
				assert.ok(call);
				assert.equal(result.details.parentToolCallId, call.message.toolCallId);
				if (nested) assert.notEqual(result.details.originatingToolCallId, call.message.toolCallId);
				else assert.equal(result.details.originatingToolCallId, call.message.toolCallId);
				assert.equal(result.details.integration.status, "applied");
				assert.ok(result.id);
				assert.ok(rows.findIndex(row => row.id === result.id) > rows.indexOf(call), "persisted history remains chronological");
			}
			for (const mode of ["resume", "fork"]) {
				const consumed = String(results().length);
				await until(() => existsSync(join(gate, "settled")) && readFileSync(join(gate, "settled"), "utf8") === consumed, "parent finishes handling the previous outcome");
				const previous = results().at(-1);
				runInPane(parent, `Call the replicate tool once with name: "continue-check", continuation: "${previous.details.continuationId}", mode: "${mode}", task: "Return exactly ${mode.toUpperCase()}_OUTPUT"`);
				const count = mode === "resume" ? 3 : 4;
				await until(() => results().length === count, `${mode} result delivered`);
				const latest = entries(parentFile).filter(row => row.message?.role === "toolResult" && row.message.toolName === "replicate").at(-1);
				assert.equal(results().at(-1).details.parentToolCallId, latest.message.toolCallId);
				assert.notEqual(results().at(-1).details.parentToolCallId, previous.details.parentToolCallId);
			}
			await until(() => existsSync(join(gate, "settled")) && readFileSync(join(gate, "settled"), "utf8") === "4", "parent has consumed every outcome");
			runInPane(parent, "/reload");
			await waitForScreen(parent, /Reloaded keybindings, extensions/, PI_TIMEOUT);
			assert.equal(results().length, 4, "reload does not deliver a second copy");
			await until(() => getProviderRequests().some(request => /SLOW_OUTPUT/.test(request.userText) && /Replica .*completed/.test(request.userText)), "full result reaches the model");
		} catch (error) {
			const launches = entries(parentFile).filter(row => row.message?.role === "toolResult" && row.message.details?.sessionFile);
			const children = await Promise.all(launches.map(async row => {
				const file = row.message.details.sessionFile;
				const binding = readSessionBinding(file);
				const location = binding?.child && childSessionLocation(binding.child.lineage.rootDir, binding.child.lineage.nodeId);
				const record = binding?.child?.environment.PI_SUBAGENT_REPLICA_WORK_FILE;
				return { file, entries: entries(file).slice(-12), location, work: record && readReplicaWork(record), screen: location?.paneId && await readPaneAsync(location.paneId, 100).catch(String) };
			}));
			const report = { parent: entries(parentFile), screen: await readPaneAsync(parent, 100), children, requests: getProviderRequests() };
			const artifacts = process.env.PI_INTEGRATION_DEBUG_ARTIFACT_DIR;
			if (artifacts) { mkdirSync(artifacts, { recursive: true }); writeFileSync(join(artifacts, "delayed-output.json"), JSON.stringify(report)); }
			assert.fail(`${error}\n${report.screen}\n${JSON.stringify(children.map(child => ({ location: child.location, work: child.work, screen: child.screen })))}`);
		} finally {
			writeFileSync(join(gate, "slow.release"), "go");
			writeFileSync(join(gate, "fast.release"), "go");
			await cleanupTestEnv(env);
		}
	});
}
