import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { childSessionLocation, readSessionBinding, sessionLocationAlive } from "../../pi-extension/subagents/session-binding.ts";
import { cleanupTestEnv, createTestEnv, createTrackedSurface, getAvailableBackends, interruptPane, PI_TIMEOUT, readPaneAsync, runInPane, shellQuote, sleep, startPi, waitForPaneReady, type TestEnv } from "./harness.ts";
import { getProviderRequests, resetProviderRequests } from "./fake-provider.ts";

function entries(file: string): any[] {
  if (!existsSync(file)) return [];
  const text = readFileSync(file, "utf8"), complete = text.slice(0, text.lastIndexOf("\n") + 1).trim();
  return complete ? complete.split("\n").map(line => JSON.parse(line)) : [];
}
async function until(check: () => boolean, message: string): Promise<void> {
  const deadline = Date.now() + PI_TIMEOUT;
  while (Date.now() < deadline) { if (check()) return; await sleep(50); }
  assert.fail(message);
}

for (const backend of getAvailableBackends()) {
  describe(`replica search work (${backend})`, { timeout: 180_000 }, () => {
    let env: TestEnv;
    beforeEach(() => { resetProviderRequests(); env = createTestEnv(backend, { replication: true }); });
    afterEach(async () => { await cleanupTestEnv(env); });

    for (const variant of ["completed", "failed", "empty-wait", "stop"]) {
      it(`returns once and closes after search ${variant}`, async () => {
        const file = join(env.dir, "parent.jsonl"), capability = join(env.dir, "search-work-fixture.ts");
        const typebox = new URL("../../node_modules/@sinclair/typebox/build/esm/index.mjs", import.meta.url).pathname;
        const boundary = variant === "completed" || variant === "failed";
        // A real extension exercises the producer's public receipt/boundary contract.
        writeFileSync(capability, `import {Type} from ${JSON.stringify(typebox)};
export default function(pi){
 let pending;
 pi.registerTool({name:${JSON.stringify(boundary ? "replication_probe" : "web_search")},label:'Search fixture',description:'Start controlled background search',parameters:Type.Object({}),async execute(id,_args,_signal,_update,ctx){
  pending=id;
  ${variant === "stop" ? `ctx.signal.addEventListener('abort',()=>{if(pending){pi.appendEntry('web-search:cancelled',{requestId:pending,status:'cancelled'});pending=undefined;}},{once:true});` : ""}
  return {content:[{type:'text',text:'SEARCH_REQUEST_STARTED'}],details:{requestId:id,status:'running'}};
 }});
 pi.registerTool({name:'wait_for_web_searches',label:'Wait for searches',description:'Inspect the outstanding search set',parameters:Type.Object({}),async execute(){pending=undefined;return {content:[{type:'text',text:JSON.stringify({results:[]})}],details:{results:[]}};}});
 ${boundary ? `pi.on('turn_end',event=>{if(!pending || event.outcome!=='completed')return;const id=pending;pending=undefined;return {entries:[...event.entries,{type:'custom_message',customType:'web-search:result',display:false,content:'BACKGROUND_WORK_COMPLETED exit ${variant === "failed" ? "7" : "0"}',details:{requestId:id,status:${JSON.stringify(variant)}}}],continue:true};});` : ""}
}`);
        const parent = createTrackedSurface(env, "search-work-parent");
        await waitForPaneReady(parent);
        startPi(parent, env.dir, "Return exactly SEARCH_PARENT_READY", { extraArgs: `--session ${shellQuote(file)} -e ${shellQuote(capability)}` });
        await until(() => entries(file).some(row => row.message?.role === "assistant"), "parent ready");
        const task = boundary ? "Use replication_probe Return exactly SEARCH_REQUEST_WAITING" : `SEARCH_REQUEST_${variant === "stop" ? "STOP" : "WAIT"}`;
        runInPane(parent, `Call the replicate tool once with name: "check-search-work" task: ${JSON.stringify(task)}`);
        await until(() => entries(file).some(row => row.message?.toolName === "replicate"), "copy launched");
        const launch = entries(file).find(row => row.message?.toolName === "replicate").message.details;
        const binding = readSessionBinding(launch.sessionFile)!;
        await until(() => !!childSessionLocation(binding.child!.lineage.rootDir, binding.child!.lineage.nodeId), "copy binds its location");
        const location = childSessionLocation(binding.child!.lineage.rootDir, binding.child!.lineage.nodeId)!;
        let screen: string | undefined;
        if (variant === "stop") {
          await until(() => getProviderRequests().filter(request => request.userText.includes("Your assignment:") && request.userText.includes("SEARCH_REQUEST_STOP")).length === 2, "copy waits with a live search");
          assert.equal(sessionLocationAlive(location), true);
          assert.equal(existsSync(launch.sessionFile + ".exit"), false);
          screen = await readPaneAsync(location.paneId!, 80);
          interruptPane(location.paneId!);
        }
        await until(() => entries(file).some(row => row.customType === "subagent_result"), "result returns automatically");
        await until(() => !sessionLocationAlive(location), "copy process and pane close");
        const results = entries(file).filter(row => row.customType === "subagent_result");
        assert.equal(results.length, 1);
        assert.equal(results[0].details.exitCode, variant === "stop" ? 1 : 0);
        if (variant !== "stop") assert.match(results[0].content, variant === "failed" ? /BACKGROUND_WORK_FAILED/ : boundary ? /BACKGROUND_WORK_PROCESSED/ : /SEARCH_REQUEST_DRAINED/);
        const child = entries(launch.sessionFile);
        assert.equal(child.filter(row => row.customType === "web-search:result").length, boundary ? 1 : 0);
        assert.equal(child.filter(row => row.customType === "web-search:cancelled").length, variant === "stop" ? 1 : 0);
        if (variant === "stop") assert.equal(getProviderRequests().filter(request => request.userText.includes("Your assignment:") && request.userText.includes("SEARCH_REQUEST_STOP")).length, 2, "Stop does not restart inference");
        const artifacts = process.env.PI_INTEGRATION_DEBUG_ARTIFACT_DIR;
        if (artifacts) {
          mkdirSync(artifacts, { recursive: true });
          writeFileSync(join(artifacts, `search-${variant}.json`), JSON.stringify({ child, results, screen, parentScreen: await readPaneAsync(parent, 80), location, alive: sessionLocationAlive(location) }));
        }
      });
    }
  });
}
