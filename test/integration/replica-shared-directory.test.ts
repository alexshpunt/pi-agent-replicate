import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { cleanupTestEnv, createTestEnv, createTrackedSurface, getAvailableBackends, runInPane, shellQuote, sleep, startPi, waitForPaneAbsence, waitForPaneReady, waitForScreen, PI_TIMEOUT, type TestEnv } from "./harness.ts";
import { childSessionLocation, readSessionBinding } from "../../pi-extension/subagents/session-binding.ts";

function entries(path: string): any[] {
 if (!existsSync(path)) return [];
 const s = readFileSync(path, "utf8");
 return s.slice(0, s.lastIndexOf("\n") + 1).split("\n").filter(Boolean).map(line => JSON.parse(line));
}
async function until(check: () => boolean, why: string) {
 const end = Date.now() + PI_TIMEOUT;
 while (Date.now() < end) { if (check()) return; await sleep(50); }
 assert.fail(why);
}
for (const backend of getAvailableBackends()) describe(`shared replica (${backend})`, { timeout: PI_TIMEOUT * 3 }, () => {
 let env: TestEnv;
 beforeEach(() => { env = createTestEnv(backend, { replication: true }); });
 afterEach(async () => { await cleanupTestEnv(env); });
 for (const [outcome, answer] of [["success", "REPLICATION_SUMMARY"], ["failure", "EMPTY_COMPLETION"], ["recovery", "REPLICATION_SUMMARY"], ["global", "REPLICATION_SUMMARY"]]) {
  it(`uses the parent's files and delivers ${outcome} without a worktree`, async () => {
   const session = join(env.dir, "parent.jsonl"), capability = join(env.dir, "capability.ts");
   const ready = join(env.dir, ".pi", "agent", "probe-ready"), gate = ready + "-gate";
   writeFileSync(join(env.dir, "ignored.shared"), "ignored parent data");
   writeFileSync(join(env.dir, ".gitignore"), "ignored.shared\n");
   writeFileSync(capability, `import {Type} from ${JSON.stringify(new URL("../../node_modules/@sinclair/typebox/build/esm/index.mjs", import.meta.url).pathname)}; import {readFileSync,writeFileSync,existsSync} from 'node:fs'; import {join} from 'node:path'; export default function(pi){pi.registerTool({name:'replication_probe',label:'Probe',description:'Probe files',parameters:Type.Object({}),async execute(){writeFileSync(join(process.cwd(),'child.shared'),readFileSync(join(process.cwd(),'ignored.shared'),'utf8'));writeFileSync(${JSON.stringify(ready)},process.cwd());while(!existsSync(${JSON.stringify(gate)}))await new Promise(r=>setTimeout(r,25));return {content:[],details:{}}}})}\n`);
   const parent = createTrackedSurface(env, "shared-parent"); await waitForPaneReady(parent);
   startPi(parent, env.dir, "Return exactly ORIGINAL_READY", { extraArgs: `--session ${shellQuote(session)} -e ${shellQuote(capability)}` });
   await until(() => entries(session).some(x => x.message?.role === "assistant"), "parent ready");
   runInPane(parent, outcome === "global" ? "/replica-directory --global shared" : "/replica-directory shared");
   const settings = outcome === "global" ? join(env.dir, ".pi", "agent", "replicate.json") : join(env.dir, ".pi", "replicate.json");
   await until(() => existsSync(settings), "command persisted setting");
   assert.equal(JSON.parse(readFileSync(settings, "utf8")).directoryMode, "shared");
   if (outcome === "global") assert.equal(existsSync(join(env.dir, ".pi", "replicate.json")), false);
   const branches = execFileSync("git", ["branch", "--list"], { cwd: env.dir, encoding: "utf8" });
   const trees = execFileSync("git", ["worktree", "list", "--porcelain"], { cwd: env.dir, encoding: "utf8" });
   runInPane(parent, `Call the replicate tool once with task: "Use replication_probe then Return exactly ${answer}"`);
   await until(() => existsSync(ready), "child started in shared directory");
   assert.equal(readFileSync(ready, "utf8"), env.dir);
   assert.equal(readFileSync(join(env.dir, "child.shared"), "utf8"), "ignored parent data");
   assert.equal(execFileSync("git", ["branch", "--list"], { cwd: env.dir, encoding: "utf8" }), branches);
   assert.equal(execFileSync("git", ["worktree", "list", "--porcelain"], { cwd: env.dir, encoding: "utf8" }), trees);
   if (outcome === "recovery") {
    runInPane(parent, "/reload");
    await waitForScreen(parent, /Reloaded keybindings, extensions/, PI_TIMEOUT);
   }
   writeFileSync(gate, "release");
   await until(() => entries(session).some(x => x.customType === "subagent_result"), "result delivered");
   const results = entries(session).filter(x => x.customType === "subagent_result");
   assert.equal(results.length, 1);
   assert.equal(results[0].details.exitCode, outcome === "failure" ? 1 : 0);
   assert.equal(results[0].details.integration.status, outcome === "failure" ? "not-attempted" : "shared");
   if (outcome === "failure") {
    const delivered = JSON.stringify(results[0]);
    assert.match(delivered, /partial changes may already be present/);
    assert.doesNotMatch(delivered, /unfinished work was not included/);
   }
   assert.equal(readFileSync(join(env.dir, "child.shared"), "utf8"), "ignored parent data");
   const launch = entries(session).find(x => x.message?.role === "toolResult" && x.message.toolName === "replicate");
   const binding = readSessionBinding(launch.message.details.sessionFile)!;
   const location = childSessionLocation(binding.child!.lineage.rootDir, binding.child!.lineage.nodeId)!;
   assert.equal(await waitForPaneAbsence(location.paneId!, { timeoutMs: 10000 }), true);
  });
 }
});
