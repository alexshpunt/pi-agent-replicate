import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { getProviderRequests, resetProviderRequests } from "./fake-provider.ts";
import { cleanupTestEnv, closePane, createTestEnv, createTrackedSurface, getAvailableBackends, runInPane, shellQuote, sleep, startPi, waitForPaneAbsence, waitForPaneReady, waitForScreen, type TestEnv } from "./harness.ts";
import { childSessionLocation, readSessionBinding, sessionLocationAlive } from "../../pi-extension/subagents/session-binding.ts";

const packageTools = new Set(["replicate", "subagent", "subagent_resume", "subagent_interrupt", "subagent_cancel", "subagents_list", "caller_ping", "subagent_done"]);
function entries(path: string): any[] {
	return existsSync(path) ? readFileSync(path, "utf8").trim().split("\n").map((line) => JSON.parse(line)) : [];
}
async function waitUntil(check: () => boolean, explanation: string): Promise<void> {
	const deadline = Date.now() + 20_000;
	while (Date.now() < deadline) {
		if (check()) return;
		await sleep(50);
	}
	assert.fail(explanation);
}
function systemText(request: ReturnType<typeof getProviderRequests>[number]): string {
	return JSON.stringify(request.messages.filter((message) => message.role === "system"));
}

for (const backend of getAvailableBackends()) {
	describe(`replication (${backend})`, { timeout: process.env.PI_INTEGRATION_TUI_DIR ? 660_000 : 45_000 }, () => {
		let env: TestEnv;
		beforeEach(() => { resetProviderRequests(); env = createTestEnv(backend, { replication: true }); });
		afterEach(async () => { await cleanupTestEnv(env); });

		for (const task of ["REPLICATION_FAIL_WITH_HISTORY", "Return exactly EMPTY_COMPLETION"]) {
			it(`reports ${task} as failure and retains its work`, async () => {
				const parentFile = join(env.dir, "failure-original.jsonl");
				const parent = createTrackedSurface(env, "failure-original");
				await waitForPaneReady(parent);
				startPi(parent, env.dir, "Return exactly INHERITED_ANSWER_NOT_HISTORY", { extraArgs: `--session ${shellQuote(parentFile)}` });
				await waitUntil(() => entries(parentFile).some((entry) => entry.message?.role === "assistant" && JSON.stringify(entry.message.content).includes("INHERITED_ANSWER_NOT_HISTORY")), "the inherited answer must be saved before cloning");
				runInPane(parent, `Call the replicate tool once with task: ${JSON.stringify(task)}`);
				await waitUntil(() => entries(parentFile).some((entry) => entry.customType === "subagent_result"), "failure must wake the original");
				const results = entries(parentFile).filter((entry) => entry.customType === "subagent_result");
				assert.equal(results.length, 1);
				const result = results[0];
				assert.match(result.content, /Replica .* error/);
				assert.match(result.content, task === "REPLICATION_FAIL_WITH_HISTORY" ? /deterministic replica terminal failure/ : /no required summary/);
				const history = readFileSync(result.details.historyPath, "utf8");
				assert.doesNotMatch(history, /INHERITED_ANSWER_NOT_HISTORY|TOOL_OUTPUT_NOT_AN_ANSWER|echo TOOL_OUTPUT|Call the replicate tool/);
				if (task === "REPLICATION_FAIL_WITH_HISTORY") assert.match(history, /REPLICA_FIRST_ANSWER/);
				else assert.match(history, /No textual answers were produced/);
				const binding = readSessionBinding(result.details.sessionFile)!;
				const location = childSessionLocation(binding.child!.lineage.rootDir, binding.child!.lineage.nodeId)!;
				await waitUntil(() => !sessionLocationAlive(location), "the failed model process must exit");
				assert.equal(existsSync(entries(result.details.sessionFile)[0].cwd), true);
				assert.match(result.content, /Integration: not-attempted/);
			});
		}
		it("retains partial work after repeated unexpected child process loss exhausts recovery", async () => {
			const parentFile = join(env.dir, "crash-original.jsonl"), capability = join(env.dir, "crash-capability.ts"), crashes = join(env.dir, "child-crashes.txt");
			writeFileSync(capability, `import {appendFileSync,writeFileSync} from 'node:fs'; import {join} from 'node:path'; export default function(pi){pi.on('before_agent_start',()=>{if(process.cwd()!==${JSON.stringify(env.dir)}){writeFileSync(join(process.cwd(),'crash-partial.txt'),'CRASH_PARTIAL');appendFileSync(${JSON.stringify(crashes)},process.pid+'\\n');process.kill(process.pid,'SIGKILL');}});}\n`);
			const parent = createTrackedSurface(env, "crash-original");
			await waitForPaneReady(parent);
			startPi(parent, env.dir, "Return exactly CRASH_READY", { extraArgs: `--session ${shellQuote(parentFile)} -e ${shellQuote(capability)}` });
			await waitUntil(() => entries(parentFile).some((row) => row.message?.role === "assistant"), "parent ready");
			const head = execFileSync("git", ["rev-parse", "HEAD"], { cwd: env.dir, encoding: "utf8" });
			const index = execFileSync("git", ["ls-files", "--stage"], { cwd: env.dir, encoding: "utf8" });
			runInPane(parent, 'Call the replicate tool once with task: "Return exactly UNREACHABLE_CRASH_SUMMARY"');
			await waitUntil(() => entries(parentFile).some((row) => row.customType === "subagent_result"), "exhausted crash recovery must deliver an honest terminal result");
			const results = entries(parentFile).filter((row) => row.customType === "subagent_result");
			assert.equal(results.length, 1);
			const result = results[0];
			assert.match(result.content, /Replica .* error/);
			assert.match(result.content, /Integration: not-attempted/);
			assert.equal(readFileSync(join(result.details.worktreePath, "crash-partial.txt"), "utf8"), "CRASH_PARTIAL");
			assert.ok(existsSync(result.details.sessionFile) && existsSync(result.details.historyPath));
			assert.equal(existsSync(join(env.dir, "crash-partial.txt")), false);
			assert.equal(execFileSync("git", ["rev-parse", "HEAD"], { cwd: env.dir, encoding: "utf8" }), head);
			assert.equal(execFileSync("git", ["ls-files", "--stage"], { cwd: env.dir, encoding: "utf8" }), index);
			assert.equal(new Set(readFileSync(crashes, "utf8").trim().split("\n")).size, 4, "one original process and three bounded recovery attempts");
		});
		for (const mode of ["resume", "fork"]) {
			it(`recovers failed outstanding changes with ${mode} and preserves the saved conversation`, async () => {
				const parentFile = join(env.dir, "recover-original.jsonl"), capability = join(env.dir, "recovery-capability.ts");
				writeFileSync(capability, `import {Type} from ${JSON.stringify(new URL("../../node_modules/@sinclair/typebox/build/esm/index.mjs", import.meta.url).pathname)}; import {existsSync,readFileSync,writeFileSync} from 'node:fs'; import {join} from 'node:path'; export default function(pi){pi.registerTool({name:'replication_probe',label:'Probe',description:'Write checkpoint content',parameters:Type.Object({}),async execute(){const p=join(process.cwd(),'outstanding.txt');writeFileSync(p,(existsSync(p)?readFileSync(p,'utf8'):'')+'step\\n');return {content:[{type:'text',text:'SAVED_CONVERSATION_FACT'}],details:{}}}});}\n`);
				const parent = createTrackedSurface(env, "recover-original");
				await waitForPaneReady(parent);
				startPi(parent, env.dir, "Return exactly RECOVERY_READY", { extraArgs: `--session ${shellQuote(parentFile)} -e ${shellQuote(capability)}` });
				await waitUntil(() => entries(parentFile).some((row) => row.message?.role === "assistant"), "parent ready");
				runInPane(parent, 'Call the replicate tool once with task: "Use replication_probe then Return exactly EMPTY_COMPLETION"');
				const results = () => entries(parentFile).filter((row) => row.customType === "subagent_result");
				await waitUntil(() => results().length === 1, "failed work must be returned");
				const failed = results()[0];
				assert.match(failed.content, /Integration: not-attempted/);
				assert.equal(existsSync(join(env.dir, "outstanding.txt")), false);
				const binding = readSessionBinding(failed.details.sessionFile)!;
				const location = childSessionLocation(binding.child!.lineage.rootDir, binding.child!.lineage.nodeId)!;
				await waitUntil(() => !sessionLocationAlive(location), "old attempt must exit before explicit recovery");
				runInPane(parent, `Call the replicate tool once with continuation: "${failed.details.continuationId}", mode: "${mode}", task: "Use replication_probe then Return exactly RECOVERY_SUMMARY"`);
				await waitUntil(() => results().length === 2, "recovered result must reach the requester");
				const recovered = results()[1], oldHeader = entries(failed.details.sessionFile)[0], newHeader = entries(recovered.details.sessionFile)[0];
				assert.match(recovered.content, /RECOVERY_SUMMARY/);
				assert.match(recovered.content, /Integration: applied/);
				assert.equal(readFileSync(join(env.dir, "outstanding.txt"), "utf8"), "step\nstep\n");
				if (mode === "resume") assert.equal(newHeader.id, oldHeader.id);
				else assert.notEqual(newHeader.id, oldHeader.id);
				assert.notEqual(recovered.details.continuationId, failed.details.continuationId, "attempt results remain distinct");
				const request = getProviderRequests().find((item) => item.userText.includes("Your assignment:") && item.userText.includes("RECOVERY_SUMMARY"));
				assert.ok(request);
				assert.match(request.text, /SAVED_CONVERSATION_FACT/);
				assert.equal(await waitForPaneAbsence(childSessionLocation(readSessionBinding(recovered.details.sessionFile)!.child!.lineage.rootDir, readSessionBinding(recovered.details.sessionFile)!.child!.lineage.nodeId)!.paneId!, { timeoutMs: 10_000 }), true);
			});
		}
		it("joins two isolated siblings without dropping current parent work or staging", async () => {
			const parentFile = join(env.dir, "siblings-original.jsonl"), capability = join(env.dir, "siblings-capability.ts");
			const gate = join(env.dir, ".pi", "agent", "siblings-gate"), markers = gate + ".started";
			mkdirSync(markers);
			writeFileSync(capability, `import {Type} from ${JSON.stringify(new URL("../../node_modules/@sinclair/typebox/build/esm/index.mjs", import.meta.url).pathname)}; import {existsSync,writeFileSync} from 'node:fs'; import {join} from 'node:path'; export default function(pi){pi.registerTool({name:'replication_probe',label:'Probe',description:'Write isolated sibling source',parameters:Type.Object({}),async execute(){const id=process.env.PI_SUBAGENT_ID;writeFileSync(join(process.cwd(),id+'.txt'),id);writeFileSync(join(${JSON.stringify(markers)},id),'ready');const end=Date.now()+20000;while(!existsSync(${JSON.stringify(gate)})&&Date.now()<end)await new Promise(r=>setTimeout(r,25));if(!existsSync(${JSON.stringify(gate)}))throw new Error('gate timeout');return {content:[{type:'text',text:'sibling source written'}],details:{}}}});}\n`);
			const parent = createTrackedSurface(env, "siblings-original");
			await waitForPaneReady(parent);
			startPi(parent, env.dir, "Return exactly SIBLINGS_READY", { extraArgs: `--session ${shellQuote(parentFile)} -e ${shellQuote(capability)}` });
			await waitUntil(() => entries(parentFile).some((row) => row.message?.role === "assistant"), "parent ready");
			runInPane(parent, 'Call the replicate tool once with task: "Use replication_probe then Return exactly FIRST_SIBLING"');
			await waitUntil(() => readdirSync(markers).length === 1, "first sibling started");
			runInPane(parent, 'Call the replicate tool once with task: "Use replication_probe then Return exactly SECOND_SIBLING"');
			await waitUntil(() => readdirSync(markers).length === 2, "second sibling started without sharing source");
			const ids = readdirSync(markers);
			for (const id of ids) assert.equal(existsSync(join(env.dir, id + ".txt")), false);
			writeFileSync(join(env.dir, "parent.txt"), "parent staged");
			execFileSync("git", ["add", "parent.txt"], { cwd: env.dir });
			writeFileSync(join(env.dir, "parent.txt"), "parent working");
			const index = readFileSync(join(env.dir, ".git", "index"));
			writeFileSync(gate, "go");
			await waitUntil(() => entries(parentFile).filter((row) => row.customType === "subagent_result").length === 2, "both sibling results must join");
			for (const result of entries(parentFile).filter((row) => row.customType === "subagent_result")) assert.match(result.content, /Integration: applied/);
			for (const id of ids) assert.equal(readFileSync(join(env.dir, id + ".txt"), "utf8"), id);
			assert.equal(readFileSync(join(env.dir, "parent.txt"), "utf8"), "parent working");
			assert.deepEqual(readFileSync(join(env.dir, ".git", "index")), index);
		});
		it("reports a host join conflict without applying any child file or replacing parent staging", async () => {
			const parentFile = join(env.dir, "conflict-original.jsonl"), capability = join(env.dir, "conflict-capability.ts");
			const gate = join(env.dir, ".pi", "agent", "conflict-release"), started = gate + ".started";
			writeFileSync(join(env.dir, "collision.txt"), "base\n");
			writeFileSync(capability, `import {Type} from ${JSON.stringify(new URL("../../node_modules/@sinclair/typebox/build/esm/index.mjs", import.meta.url).pathname)}; import {existsSync,writeFileSync} from 'node:fs'; import {join} from 'node:path'; export default function(pi){pi.registerTool({name:'replication_probe',label:'Probe',description:'Write gated child files',parameters:Type.Object({}),async execute(){writeFileSync(join(process.cwd(),'collision.txt'),'child\\n');writeFileSync(join(process.cwd(),'child-only.txt'),'retained');writeFileSync(${JSON.stringify(started)},'ready');const deadline=Date.now()+20000;while(!existsSync(${JSON.stringify(gate)})&&Date.now()<deadline)await new Promise(r=>setTimeout(r,25));if(!existsSync(${JSON.stringify(gate)}))throw new Error('gate timeout');return {content:[{type:'text',text:'CAPABILITY_INHERITED'}],details:{}}}});}\n`);
			const parent = createTrackedSurface(env, "conflict-original");
			await waitForPaneReady(parent);
			startPi(parent, env.dir, "Return exactly CONFLICT_READY", { extraArgs: `--session ${shellQuote(parentFile)} -e ${shellQuote(capability)}` });
			await waitUntil(() => entries(parentFile).some((row) => row.message?.role === "assistant"), "parent ready");
			runInPane(parent, 'Call the replicate tool once with task: "Use replication_probe then Return exactly CONFLICT_TASK_FINISHED"');
			await waitUntil(() => existsSync(started), "child must have written its isolated files");
			writeFileSync(join(env.dir, "collision.txt"), "parent staged\n");
			execFileSync("git", ["add", "collision.txt"], { cwd: env.dir });
			writeFileSync(join(env.dir, "collision.txt"), "parent working\n");
			const index = readFileSync(join(env.dir, ".git", "index")), head = execFileSync("git", ["rev-parse", "HEAD"], { cwd: env.dir, encoding: "utf8" });
			writeFileSync(gate, "go");
			await waitUntil(() => entries(parentFile).some((row) => row.customType === "subagent_result"), "conflict must return task summary and retained pointer");
			const result = entries(parentFile).find((row) => row.customType === "subagent_result");
			assert.match(result.content, /completed[\s\S]*CONFLICT_TASK_FINISHED[\s\S]*Integration: conflict/);
			assert.match(result.content, /Continuation:|Checkpoint:/);
			assert.equal(readFileSync(join(env.dir, "collision.txt"), "utf8"), "parent working\n");
			assert.equal(existsSync(join(env.dir, "child-only.txt")), false);
			assert.deepEqual(readFileSync(join(env.dir, ".git", "index")), index);
			assert.equal(execFileSync("git", ["rev-parse", "HEAD"], { cwd: env.dir, encoding: "utf8" }), head);
			assert.equal(readFileSync(join(result.details.worktreePath, "child-only.txt"), "utf8"), "retained");
		});
		it("rebuilds an applied cleaned continuation without reapplying its old changes", async () => {
			const parentFile = join(env.dir, "cleaned-original.jsonl"), capability = join(env.dir, "cleaned-capability.ts");
			writeFileSync(capability, `import {Type} from ${JSON.stringify(new URL("../../node_modules/@sinclair/typebox/build/esm/index.mjs", import.meta.url).pathname)}; import {existsSync,writeFileSync} from 'node:fs'; import {join} from 'node:path'; export default function(pi){pi.registerTool({name:'replication_probe',label:'Probe',description:'Write a new source file',parameters:Type.Object({}),async execute(){const old=join(process.cwd(),'old.txt');writeFileSync(existsSync(old)?join(process.cwd(),'new.txt'):old,'CHILD');return {content:[{type:'text',text:'CAPABILITY_INHERITED'}],details:{}}}});}\n`);
			const parent = createTrackedSurface(env, "cleaned-original");
			await waitForPaneReady(parent);
			startPi(parent, env.dir, "Return exactly CLEANED_READY", { extraArgs: `--session ${shellQuote(parentFile)} -e ${shellQuote(capability)}` });
			await waitUntil(() => entries(parentFile).some((row) => row.message?.role === "assistant"), "parent ready");
			runInPane(parent, 'Call the replicate tool once with task: "Use replication_probe then Return exactly FIRST_APPLIED"');
			const results = () => entries(parentFile).filter((row) => row.customType === "subagent_result");
			await waitUntil(() => results().length === 1, "first work must join");
			const first = results()[0];
			assert.match(first.content, /Integration: applied/);
			await waitUntil(() => !existsSync(first.details.worktreePath), "successful worktree must disappear before recovery");
			writeFileSync(join(env.dir, "old.txt"), "PARENT_LATER");
			runInPane(parent, `Call the replicate tool once with continuation: "${first.details.continuationId}", mode: "fork", task: "Use replication_probe then Return exactly NEXT_APPLIED"`);
			await waitUntil(() => results().length === 2, "cleaned continuation must be reconstructed");
			assert.match(results()[1].content, /Integration: applied/);
			assert.equal(readFileSync(join(env.dir, "old.txt"), "utf8"), "PARENT_LATER");
			assert.equal(readFileSync(join(env.dir, "new.txt"), "utf8"), "CHILD");
		});
		it("renders an active isolated replica and its applied result after native reload", { skip: !process.env.PI_INTEGRATION_TUI_DIR }, async () => {
			const inspection = process.env.PI_INTEGRATION_TUI_DIR!;
			const ide = process.env.PI_INTEGRATION_IDE_ENTRY;
			assert.ok(ide && existsSync(ide), "visual verification requires the current IDE source");
			mkdirSync(inspection, { recursive: true });
			const parentFile = join(env.dir, "visual-original.jsonl"), capability = join(env.dir, "visual-capability.ts");
			writeFileSync(capability, `import {Type} from ${JSON.stringify(new URL("../../node_modules/@sinclair/typebox/build/esm/index.mjs", import.meta.url).pathname)};
import {existsSync,readFileSync,writeFileSync} from 'node:fs'; import {join} from 'node:path';
const inspection=${JSON.stringify(inspection)};
export default function(pi){
  if(process.env.PI_SUBAGENT_REPLICATION!=='1') pi.on('session_start',()=>{
    const file=join(inspection,'runtime.json');
    const starts=existsSync(file)?JSON.parse(readFileSync(file,'utf8')).starts:0;
    const read=pi.getAllTools().find(tool=>tool.name==='read');
    writeFileSync(file,JSON.stringify({starts:starts+1,readHasViews:!!read?.parameters?.properties?.views,argv:process.argv,ideSource:process.env.PI_INTEGRATION_IDE_SOURCE_COMMIT}));
  });
  pi.registerTool({name:'replication_probe',label:'Probe',description:'Write isolated work and hold it for visual inspection',parameters:Type.Object({}),async execute(){
    writeFileSync(join(process.cwd(),'visual-change.txt'),'VISUAL_CHILD_EDIT');
    writeFileSync(join(inspection,'child-active.json'),JSON.stringify({cwd:process.cwd(),pid:process.pid}));
    const deadline=Date.now()+300000;
    while(!existsSync(join(inspection,'release-child'))){if(Date.now()>deadline)throw new Error('visual inspection release timed out');await new Promise(resolve=>setTimeout(resolve,50));}
    return {content:[{type:'text',text:'CAPABILITY_INHERITED'}],details:{}};
  }});
}
`);
			const parent = createTrackedSurface(env, "visual-original");
			await waitForPaneReady(parent);
			startPi(parent, env.dir, "Return exactly VISUAL_READY", { extraArgs: `--session ${shellQuote(parentFile)} -e ${shellQuote(ide)} -e ${shellQuote(capability)}` });
			await waitUntil(() => entries(parentFile).some((row) => row.message?.role === "assistant"), "native parent ready");
			runInPane(parent, "/reload");
			await waitUntil(() => existsSync(join(inspection, "runtime.json")) && JSON.parse(readFileSync(join(inspection, "runtime.json"), "utf8")).starts >= 2, "the native reload must reattach the same source");
			assert.equal(JSON.parse(readFileSync(join(inspection, "runtime.json"), "utf8")).readHasViews, true, "the loaded read tool must be IDE's native tool, not Pi's built-in reader");
			runInPane(parent, 'INTEGRATION_VISUAL_PARENT. Call the replicate tool once with task: "Use replication_probe then Return exactly REPLICATION_SUMMARY"');
			await waitUntil(() => existsSync(join(inspection, "child-active.json")), "child active in isolated checkout");
			assert.notEqual(JSON.parse(readFileSync(join(inspection, "child-active.json"), "utf8")).cwd, env.dir);
			const active = await waitForScreen(parent, /1 active/, 20_000);
			writeFileSync(join(inspection, "active.txt"), active);
			writeFileSync(join(inspection, "pane.json"), JSON.stringify({ stage: "active", pane: parent, config: process.env.HERDR_CONFIG_PATH, socket: process.env.HERDR_SOCKET_PATH }));
			const releaseDeadline = Date.now() + 300_000;
			while (!existsSync(join(inspection, "release-child"))) { assert.ok(Date.now() < releaseDeadline, "visual observer must release the child"); await sleep(100); }
			await waitUntil(() => entries(parentFile).some((row) => row.customType === "subagent_result"), "one saved result must wake the parent");
			const results = entries(parentFile).filter((row) => row.customType === "subagent_result");
			assert.equal(results.length, 1);
			assert.match(results[0].content, /REPLICATION_SUMMARY[\s\S]*Integration: applied/);
			assert.equal(readFileSync(join(env.dir, "visual-change.txt"), "utf8"), "VISUAL_CHILD_EDIT");
			const delivered = await waitForScreen(parent, /REPLICATION_SUMMARY/, 20_000);
			writeFileSync(join(inspection, "delivered.txt"), delivered);
			writeFileSync(join(inspection, "result.json"), JSON.stringify(results[0]));
			writeFileSync(join(inspection, "pane.json"), JSON.stringify({ stage: "delivered", pane: parent, config: process.env.HERDR_CONFIG_PATH, socket: process.env.HERDR_SOCKET_PATH }));
			const finishDeadline = Date.now() + 300_000;
			while (!existsSync(join(inspection, "finish"))) { assert.ok(Date.now() < finishDeadline, "visual observer must finish before cleanup"); await sleep(100); }
		});
		it("forks the current conversation with one inherited tool surface and returns one summary", async () => {
			const parentFile = join(env.dir, "original.jsonl");
			const capability = join(env.dir, "parent-only-capability.ts");
			writeFileSync(join(env.dir, "snapshot-source.txt"), "FORK_FILE");
			writeFileSync(capability, `import { Type } from ${JSON.stringify(new URL("../../node_modules/@sinclair/typebox/build/esm/index.mjs", import.meta.url).pathname)};\nimport {writeFileSync} from 'node:fs'; import {join} from 'node:path'; export default function(pi) { pi.on('before_agent_start', (event) => ({systemPrompt: event.systemPrompt + '\\nCUSTOM_CAPABILITY_SYSTEM'})); pi.registerTool({name:'replication_probe',label:'Probe',description:'Verify inherited capability',parameters:Type.Object({}),async execute(){writeFileSync(join(process.cwd(),'replica-change.txt'),'CHILD_EDIT');return {content:[{type:'text',text:'CAPABILITY_INHERITED'}],details:{}}}}); }\n`);
			const parent = createTrackedSurface(env, "replication-original");
			await waitForPaneReady(parent);
			startPi(parent, env.dir, "Earlier fact: EARLIER_REPLICATION_CONTEXT. Return exactly ORIGINAL_READY", { extraArgs: `--session ${shellQuote(parentFile)} -e ${shellQuote(capability)}` });
			await waitUntil(() => entries(parentFile).some((entry) => entry.message?.role === "assistant" && JSON.stringify(entry.message.content).includes("ORIGINAL_READY")), "the original must persist its initial answer, not just echo the input");
			const first = getProviderRequests()[0];
			assert.deepEqual(first.tools.filter((name) => packageTools.has(name)), ["replicate"]);

			runInPane(parent, 'Current fact: CURRENT_REPLICATION_CONTEXT. Call the replicate tool once with task: "Use replication_probe then Return exactly REPLICATION_SUMMARY"');
			await waitUntil(() => entries(parentFile).some((entry) => entry.type === "custom_message" && entry.customType === "subagent_result"), "the original must receive its clone summary");
			const deliveries = entries(parentFile).filter((entry) => entry.type === "custom_message" && entry.customType === "subagent_result");
			assert.equal(deliveries.length, 1);
			assert.match(deliveries[0].content, /REPLICATION_SUMMARY/);
			assert.ok(existsSync(deliveries[0].details.resultPath));
			const childFile = deliveries[0].details.sessionFile;
			const binding = readSessionBinding(childFile);
			assert.ok(binding?.child);
			assert.notEqual(entries(childFile)[0].cwd, env.dir, "the clone must own a separate worktree");
			assert.equal(execFileSync("git", ["show", `${deliveries[0].details.checkpoint}:snapshot-source.txt`], { cwd: env.dir, encoding: "utf8" }), "FORK_FILE", "the source snapshot remains after cleanup");
			assert.match(deliveries[0].content, /Integration: applied/);
			assert.equal(readFileSync(join(env.dir, "replica-change.txt"), "utf8"), "CHILD_EDIT");
			const childRequest = getProviderRequests().find((request) => request.userText.includes("REPLICATION_SUMMARY") && !request.userText.includes("Call the replicate tool"));
			assert.ok(childRequest, "the clone must make a real provider request");
			assert.match(childRequest.text, /EARLIER_REPLICATION_CONTEXT/);
			assert.match(childRequest.text, /CURRENT_REPLICATION_CONTEXT/);
			assert.equal(systemText(childRequest), systemText(first));
			assert.equal(childRequest.model, first.model);
			assert.deepEqual(childRequest.tools, first.tools);
			assert.ok(entries(childFile).some((entry) => entry.message?.role === "toolResult" && entry.message.toolName === "replication_probe" && JSON.stringify(entry.message.content).includes("CAPABILITY_INHERITED")), "the inherited custom tool must actually execute");
			assert.deepEqual(childRequest.tools.filter((name) => packageTools.has(name)), ["replicate"]);
			const location = childSessionLocation(binding.child.lineage.rootDir, binding.child.lineage.nodeId);
			assert.ok(location?.paneId);
			assert.equal(await waitForPaneAbsence(location.paneId, { timeoutMs: 10_000 }), true);
			assert.equal(existsSync(entries(childFile)[0].cwd), false, "successful joined worktrees are cleaned");
			// The clone closes only its own surface, not the original's.
			runInPane(parent, "Return exactly ORIGINAL_STILL_OPEN");
			await waitForScreen(parent, /ORIGINAL_STILL_OPEN/);
			closePane(parent);
		});
	});
}
