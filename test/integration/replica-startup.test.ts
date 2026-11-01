import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { getProviderRequests, resetProviderRequests } from "./fake-provider.ts";
import { cleanupTestEnv, createTestEnv, createTrackedSurface, getAvailableBackends, runInPane, shellQuote, sleep, startPi, waitForPaneReady, waitForScreen, type TestEnv } from "./harness.ts";
import { childSessionLocation, readSessionBinding, sessionLocationAlive } from "../../pi-extension/subagents/session-binding.ts";

function entries(path: string): any[] {
	return existsSync(path) ? readFileSync(path, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line)) : [];
}

async function waitUntil(check: () => boolean, explanation: string): Promise<void> {
	const deadline = Date.now() + 45_000;
	while (Date.now() < deadline) {
		if (check()) return;
		await sleep(50);
	}
	assert.fail(explanation);
}

for (const backend of getAvailableBackends()) {
	describe(`replica startup (${backend})`, { timeout: 120_000 }, () => {
		let env: TestEnv;
		beforeEach(() => { resetProviderRequests(); env = createTestEnv(backend, { replication: true }); });
		afterEach(async () => {
			const artifacts = process.env.PI_INTEGRATION_STARTUP_ARTIFACTS_DIR;
			if (artifacts) {
				mkdirSync(artifacts, { recursive: true });
				const parentFile = join(env.dir, "startup-parent.jsonl");
				const runtimeFile = join(env.dir, ".pi", "agent", "startup-runtime.json");
				if (existsSync(runtimeFile)) writeFileSync(join(artifacts, "runtime.json"), readFileSync(runtimeFile));
				if (existsSync(parentFile)) {
					writeFileSync(join(artifacts, "parent.jsonl"), readFileSync(parentFile));
					const launch = entries(parentFile).find((row) => row.message?.toolName === "replicate");
					const child = launch?.message.details?.sessionFile;
					if (child && existsSync(child)) writeFileSync(join(artifacts, "child.jsonl"), readFileSync(child));
				}
				writeFileSync(join(artifacts, "requests.json"), JSON.stringify(getProviderRequests(), null, 2));
				if (existsSync(runtimeFile + ".events")) writeFileSync(join(artifacts, "events.jsonl"), readFileSync(runtimeFile + ".events"));
			}
			await cleanupTestEnv(env);
		});

		it("receives its assignment once instead of restoring the parent's pending background answer", async () => {
			const parentFile = join(env.dir, "startup-parent.jsonl");
			const capability = join(env.dir, "startup-capability.ts");
			const settled = join(env.dir, ".pi", "agent", "startup-parent-settled");
			const runtimeFile = join(env.dir, ".pi", "agent", "startup-runtime.json");
			const ide = process.env.PI_INTEGRATION_IDE_ENTRY;
			// A small extension reproduces the queue-restoration mechanism without
			// depending on another package's form UI or its private queue format.
			writeFileSync(capability, `import {appendFileSync,existsSync,readFileSync,writeFileSync} from 'node:fs';
export default function(pi){
  for(const event of ['input','before_agent_start','agent_start','agent_end','agent_settled']) pi.on(event,(data,ctx)=>appendFileSync(${JSON.stringify(runtimeFile + '.events')},JSON.stringify({event,replica:process.env.PI_SUBAGENT_ID,id:ctx.sessionManager.getSessionId(),source:data.source,text:data.text,messages:data.messages?.map(message=>({role:message.role,stopReason:message.stopReason}))})+'\\n'));
  pi.on('tool_call',event=>{
    if(event.toolName==='replicate'&&process.env.PI_SUBAGENT_REPLICATION!=='1')
      pi.appendEntry('startup-test:ready',{answer:'Return exactly PARENT_BACKGROUND_ANSWER'});
  });
  pi.on('session_start',(_event,ctx)=>{
    const file=${JSON.stringify(runtimeFile)};
    const runtime=existsSync(file)?JSON.parse(readFileSync(file,'utf8')):{};
    runtime[ctx.sessionManager.getSessionId()]={starts:(runtime[ctx.sessionManager.getSessionId()]?.starts??0)+1,readHasViews:!!pi.getAllTools().find(t=>t.name==='read')?.parameters?.properties?.views,argv:process.argv,ideSource:process.env.PI_INTEGRATION_IDE_SOURCE_COMMIT,ideVersion:process.env.PI_INTEGRATION_IDE_PACKAGE_VERSION};
    writeFileSync(file,JSON.stringify(runtime));
    const branch=ctx.sessionManager.getBranch();
    const pending=branch.some(row=>row.type==='custom'&&row.customType==='startup-test:ready');
    const delivered=branch.some(row=>row.type==='custom_message'&&row.customType==='startup-test:answer');
    if(pending&&!delivered) queueMicrotask(()=>{
      if(ctx.isIdle()&&!ctx.signal) pi.sendMessage({customType:'startup-test:answer',content:'Return exactly PARENT_BACKGROUND_ANSWER',display:true,details:{}},{triggerTurn:true});
    });
  });
  if(process.env.PI_SUBAGENT_REPLICATION!=='1') pi.on('agent_settled',(_event,ctx)=>{
    writeFileSync(${JSON.stringify(settled)},JSON.stringify({results:ctx.sessionManager.getEntries().filter(row=>row.type==='custom_message'&&row.customType==='subagent_result').length,answers:ctx.sessionManager.getEntries().filter(row=>row.type==='custom_message'&&row.customType==='startup-test:answer').length}));
  });
}
`);
			const parent = createTrackedSurface(env, "startup-parent");
			await waitForPaneReady(parent);
			startPi(parent, env.dir, "Earlier context: KEEP_STARTUP_CONTEXT. Return exactly STARTUP_READY", {
				extraArgs: `--session ${shellQuote(parentFile)} -e ${shellQuote(capability)}`,
			});
			await waitUntil(() => entries(parentFile).some((row) => row.message?.role === "assistant"), "parent ready");
			runInPane(parent, 'Call the replicate tool once with task: "Return exactly CHILD_STARTUP_ASSIGNED"');
			await waitUntil(() => entries(parentFile).some((row) => row.message?.toolName === "replicate"), "the replica launch is saved");
			const launch = entries(parentFile).find((row) => row.message?.toolName === "replicate");
			assert.equal(launch.message.isError, false, JSON.stringify(launch.message));
			const childFile = launch.message.details.sessionFile;
			await waitUntil(() => entries(childFile).some((row) => row.message?.role === "assistant" && /CHILD_STARTUP_ASSIGNED|PARENT_BACKGROUND_ANSWER/.test(JSON.stringify(row.message.content)) && row.message.stopReason === "stop"), "the replica saves its own final answer");
			const childRows = entries(childFile);
			const assignments = childRows.filter((row) => row.message?.role === "user" && JSON.stringify(row.message.content).includes("Your assignment:"));
			assert.equal(assignments.length, 1, "the CLI assignment is saved exactly once");
			assert.match(JSON.stringify(childRows.at(-1).message.content), /CHILD_STARTUP_ASSIGNED/);
			assert.ok(childRows.some((row) => JSON.stringify(row.message?.content ?? "").includes("KEEP_STARTUP_CONTEXT")));
			assert.equal(childRows.some((row) => row.customType === "startup-test:answer"), false);
			assert.equal(childRows.some((row) => row.type === "custom" && row.customType === "startup-test:ready"), false);
			const requests = getProviderRequests().filter((request) => request.userText.includes("Your assignment:"));
			assert.equal(requests.length, 1);
			assert.match(requests[0].userText, /CHILD_STARTUP_ASSIGNED/);
			const binding = readSessionBinding(childFile)!;
			const location = childSessionLocation(binding.child!.lineage.rootDir, binding.child!.lineage.nodeId)!;
			await waitUntil(() => !sessionLocationAlive(location), "the settled replica process exits");
			await waitUntil(() => existsSync(settled), "parent finishes its launch turn before reload");

			// The parent's control entries were not consumed, removed or modified.
			runInPane(parent, "/reload");
			await waitUntil(() => entries(parentFile).filter((row) => row.customType === "startup-test:answer").length === 1, "the parent still receives its pending answer");
			await waitUntil(() => getProviderRequests().some((request) => request.userText === "Return exactly PARENT_BACKGROUND_ANSWER"), "the parent's answer starts its own turn");
			await waitForScreen(parent, /PARENT_BACKGROUND_ANSWER/, 10_000);
			await waitUntil(() => JSON.parse(readFileSync(settled, "utf8")).answers === 1, "parent finishes handling its own background answer");
			runInPane(parent, "/reload");
			await waitForScreen(parent, /Reloaded keybindings, extensions/, 10_000);
			await waitUntil(() => JSON.parse(readFileSync(runtimeFile, "utf8"))[entries(parentFile)[0].id].starts === 3, "the second reload actually restored this session");
			assert.equal(entries(parentFile).filter((row) => row.customType === "startup-test:answer").length, 1, "reload cannot deliver it twice");

			const runtime = JSON.parse(readFileSync(runtimeFile, "utf8"));
			if (ide) {
				for (const session of Object.values(runtime) as any[]) {
					assert.equal(session.readHasViews, true, "the runner actually loaded IDE's read tool");
					assert.ok(session.argv.some((value: string) => value.endsWith("/ide-under-test.ts")));
					assert.equal(session.ideSource, process.env.PI_INTEGRATION_IDE_SOURCE_COMMIT);
					assert.equal(session.ideVersion, process.env.PI_INTEGRATION_IDE_PACKAGE_VERSION);
				}
			}
		});
	});
}
