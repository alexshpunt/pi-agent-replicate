import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { childSessionLocation, readSessionBinding, sessionLocationAlive } from "../../pi-extension/subagents/session-binding.ts";
import { cleanupTestEnv, createTestEnv, createTrackedSurface, getAvailableBackends, PI_TIMEOUT, readPaneAsync, runInPane, shellQuote, sleep, startPi, waitForPaneReady, type TestEnv } from "./harness.ts";
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
const packageTools = new Set(["replicate", "subagent", "subagent_resume", "subagent_interrupt", "subagent_cancel", "subagents_list", "caller_ping", "subagent_done"]);

for (const backend of getAvailableBackends()) {
  describe(`replica session work (${backend})`, { timeout: 180_000 }, () => {
    let env: TestEnv;
    beforeEach(() => { resetProviderRequests(); env = createTestEnv(backend, { replication: true }); });
    afterEach(async () => { await cleanupTestEnv(env); });

    it("returns automatically after deleting a background terminal without a completion message", async () => {
      const file = join(env.dir, "parent.jsonl"), capability = join(env.dir, "deleted-terminal-fixture.ts");
      const typebox = new URL("../../node_modules/@sinclair/typebox/build/esm/index.mjs", import.meta.url).pathname;
      writeFileSync(capability, `import {Type} from ${JSON.stringify(typebox)};
import {spawn} from 'node:child_process'; import {once} from 'node:events';
export default function(pi){
 let context, child;
 const source='shell:fixture-work';
 pi.on('session_start',(_event,ctx)=>{context=ctx;});
 pi.on('session_shutdown',()=>{child?.kill();});
 pi.registerTool({name:'replication_probe',label:'Background job',description:'Start session work',parameters:Type.Object({}),async execute(){
  child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});
  return {content:[{type:'text',text:'DELETED_TERMINAL_STARTED'}],details:{source,pid:child.pid,origin:{sessionId:context.sessionManager.getSessionId()},status:'running',background:true}};
 }});
 pi.registerTool({name:'delete',label:'Delete terminal',description:'Delete session work',parameters:Type.Object({path:Type.String()}),async execute(_id,{path}){
  if(path!==source) throw Error('Unknown fixture terminal');
  const snapshot={source,pid:child.pid,status:'running',origin:{sessionId:context.sessionManager.getSessionId()}};
  const exit=once(child,'exit'); child.kill(); await exit;
  return {content:[{type:'text',text:'DELETED_TERMINAL_REMOVED'}],details:{source,deleted:true,snapshot,action:'delete',input:'session',changedLines:[]}};
 }});
}`);
      const parent = createTrackedSurface(env, "deleted-terminal-parent");
      await waitForPaneReady(parent);
      startPi(parent, env.dir, "Return exactly BACKGROUND_PARENT_READY", { extraArgs: `--session ${shellQuote(file)} -e ${shellQuote(capability)}` });
      try { await until(() => entries(file).some(row => row.message?.role === "assistant"), "parent ready"); }
      catch (error) { console.error(await readPaneAsync(parent, 100)); throw error; }
      runInPane(parent, 'Call the replicate tool once with name: "check-deleted-terminal" task: "DELETED_TERMINAL_WORK"');
      await until(() => entries(file).some(row => row.message?.toolName === "replicate"), "copy launched");
      const launch = entries(file).find(row => row.message?.toolName === "replicate").message.details;
      await until(() => entries(file).some(row => row.customType === "subagent_result"), "deleted terminal must not block result delivery");
      const results = entries(file).filter(row => row.customType === "subagent_result");
      assert.equal(results.length, 1);
      assert.equal(results[0].details.exitCode, 0);
      assert.equal(results[0].details.integration.status, "applied");
      const child = entries(launch.sessionFile);
      const deleted = child.filter(row => row.message?.toolName === "delete");
      assert.equal(deleted.length, 1);
      assert.equal(deleted[0].message.isError, false);
      assert.equal(deleted[0].message.details.deleted, true);
      assert.equal(child.some(row => row.customType === "terminal-completion" || row.message?.customType === "terminal-completion"), false);
      const snapshots = child.filter(row => row.customType === "replica-session-work");
      assert.deepEqual(snapshots.at(-1).data.terminals, []);
      const binding = readSessionBinding(launch.sessionFile)!;
      const location = childSessionLocation(binding.child!.lineage.rootDir, binding.child!.lineage.nodeId)!;
      await until(() => !sessionLocationAlive(location), "copy exits after deleting its terminal");
      assert.match(await readPaneAsync(parent, 80), /check-deleted-terminal/);
    });
    for (const variant of ["terminal", "failed-terminal", "process"]) {
      it(`processes background work before returning (${variant})`, async () => {
        const file = join(env.dir, "parent.jsonl"), gate = join(env.dir, ".pi", "agent", "release-work"), started = gate + ".started";
        const capability = join(env.dir, "session-work-fixture.ts");
        const typebox = new URL("../../node_modules/@sinclair/typebox/build/esm/index.mjs", import.meta.url).pathname;
        writeFileSync(capability, `import {Type} from ${JSON.stringify(typebox)};
import {spawn} from 'node:child_process'; import {writeFileSync} from 'node:fs';
export default function(pi){
 let context, child;
 pi.on('session_start',(_event,ctx)=>{context=ctx;});
 pi.on('session_shutdown',()=>{child?.kill();});
 pi.registerTool({name:'replication_probe',label:'Background job',description:'Start finite session work',parameters:Type.Object({}),async execute(){
  child=spawn(process.execPath,['-e',${JSON.stringify(`const {existsSync}=require('node:fs'); const timer=setInterval(()=>{if(existsSync(${JSON.stringify(gate)})){clearInterval(timer);process.exit(${variant === "failed-terminal" ? 7 : 0});}},25);`)}],{stdio:'ignore'});
  const origin={sessionId:context.sessionManager.getSessionId()}, source='shell:fixture-work';
  ${variant === "process" ? "" : `child.once('exit',code=>{setTimeout(()=>pi.sendMessage({customType:'terminal-completion',display:false,content:'BACKGROUND_WORK_COMPLETED exit '+code,details:{sessions:[{source,status:'completed',exitCode:code,origin}]}},{triggerTurn:true,deliverAs:'steer'}),150);});`}
  writeFileSync(${JSON.stringify(started)},String(child.pid));
  return {content:[{type:'text',text:'BACKGROUND_WORK_STARTED'}],details:{pid:child.pid,${variant === "process" ? "" : "source,origin,background:true,status:'running'"}}};
 }});
}`);
        const parent = createTrackedSurface(env, "session-work-parent");
        await waitForPaneReady(parent);
        startPi(parent, env.dir, "Return exactly BACKGROUND_PARENT_READY", { extraArgs: `--session ${shellQuote(file)} -e ${shellQuote(capability)}` });
        await until(() => entries(file).some(row => row.message?.role === "assistant"), "parent ready");
        runInPane(parent, 'Call the replicate tool once with name: "check-background-work" task: "Use replication_probe then Return exactly BACKGROUND_WORK_WAITING"');
        let launch: any;
        try {
          await until(() => existsSync(started) && entries(file).some(row => row.message?.toolName === "replicate"), "copy starts its background job");
          launch = entries(file).find(row => row.message?.toolName === "replicate").message.details;
          await until(() => entries(launch.sessionFile).some(row => row.message?.role === "assistant" && JSON.stringify(row.message.content).includes("BACKGROUND_WORK_WAITING")), "copy settles before completion");
          const binding = readSessionBinding(launch.sessionFile)!;
          const location = childSessionLocation(binding.child!.lineage.rootDir, binding.child!.lineage.nodeId)!;
          if (variant === "terminal") await sleep(11_000); // Explicitly cross the stopped-replica watchdog deadline.
          assert.equal(sessionLocationAlive(location), true, "live background work keeps the copy alive");
          assert.equal(existsSync(launch.sessionFile + ".exit"), false, "no terminal outcome before the job finishes");
          assert.equal(entries(file).filter(row => row.customType === "subagent_result").length, 0);
          assert.match(await readPaneAsync(location.paneId!, 60), /BACKGROUND_WORK_WAITING/);
          writeFileSync(gate, "release");
          await until(() => entries(file).some(row => row.customType === "subagent_result"), "final result returns automatically");
          const results = entries(file).filter(row => row.customType === "subagent_result");
          assert.equal(results.length, 1);
          assert.match(results[0].content, variant === "failed-terminal" ? /BACKGROUND_WORK_FAILED/ : /BACKGROUND_WORK_PROCESSED/);
          assert.doesNotMatch(results[0].content, /Saved copy:|continuation|mode.*resume/);
          assert.ok(getProviderRequests().some(request => request.userText.includes("BACKGROUND_WORK_COMPLETED") || request.userText.startsWith("Session-owned processes exited:")), "completion starts a real model request in the copy");
          for (const request of getProviderRequests()) {
            assert.deepEqual(request.tools.filter(name => packageTools.has(name)), ["replicate"]);
            assert.deepEqual(Object.keys(request.toolParameters.replicate?.properties ?? {}), ["name", "task"]);
          }
          await until(() => !sessionLocationAlive(location), "copy exits after processing its job result");
        } finally { writeFileSync(gate, "release"); }
      });
    }
  });
}
