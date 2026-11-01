import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { getProviderRequests, resetProviderRequests } from "./fake-provider.ts";
import {
  cleanupTestEnv, createTestEnv, createTrackedSurface, getAvailableBackends,
  PI_TIMEOUT, readPaneAsync, runInPane, shellQuote, sleep, startPi,
  waitForPaneAbsence, waitForPaneReady, waitForProcessesExit, waitForScreen,
  type TestEnv,
} from "./harness.ts";

const MISSING_MODULE = "replica-startup-missing-module-lpt-889";
const FAILURE_WINDOW_MS = 10_000;

interface StartupWitness {
  pid: number;
  paneId: string;
  sessionFile: string;
  cwd: string;
  at: number;
}

function entries(file: string): any[] {
  if (!existsSync(file)) return [];
  const source = readFileSync(file, "utf8");
  const complete = source.slice(0, source.lastIndexOf("\n") + 1).trim();
  return complete ? complete.split("\n").map((line: string) => JSON.parse(line)) : [];
}

async function until(check: () => boolean, explanation: string, timeoutMs = PI_TIMEOUT): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (check()) return;
    await sleep(50);
  }
  assert.fail(explanation);
}

function outcomes(file: string): any[] {
  return entries(file).filter(row => row.customType === "subagent_result" || (
    row.message?.role === "toolResult" && row.message.toolName === "replicate" && row.message.isError
  ));
}

function outcomeText(row: any): string {
  return row.customType === "subagent_result"
    ? row.content
    : row.message.content.filter((part: any) => part.type === "text").map((part: any) => part.text).join("\n");
}

function startupFixture(env: TestEnv, fail: boolean): { extension: string; witness: string; registered: string } {
  const extension = join(env.dir, "startup-extension.ts");
  const witness = join(env.dir, ".pi", "agent", "startup-witness.json");
  const registered = join(env.dir, ".pi", "agent", "child-session-started");
  writeFileSync(extension, `import {createRequire} from 'node:module';
import {writeFileSync} from 'node:fs';
import {join} from 'node:path';
const replica=process.env.PI_SUBAGENT_REPLICATION==='1';
if(replica){
 writeFileSync(${JSON.stringify(witness)},JSON.stringify({pid:process.pid,paneId:process.env.HERDR_PANE_ID,sessionFile:process.env.PI_SUBAGENT_SESSION,cwd:process.cwd(),at:Date.now()}));
 ${fail ? `writeFileSync(join(process.cwd(),'startup-partial.txt'),'STARTUP_PARTIAL_SOURCE');
 createRequire(import.meta.url)(${JSON.stringify(MISSING_MODULE)});` : "console.warn('Warning: STARTUP_WARNING_ONLY');"}
}
export default function(pi){if(replica)pi.on('session_start',()=>writeFileSync(${JSON.stringify(registered)},'started'));}
`);
  return { extension, witness, registered };
}

for (const backend of getAvailableBackends()) {
  describe(`replica startup failure (${backend})`, { timeout: PI_TIMEOUT * 3 }, () => {
    let env: TestEnv;
    beforeEach(() => { resetProviderRequests(); env = createTestEnv(backend, { replication: true }); });
    afterEach(async () => { await cleanupTestEnv(env); });

    it("closes an attempt that fails before child initialization and reports its diagnostic once", async () => {
      const parentFile = join(env.dir, "parent.jsonl");
      const fixture = startupFixture(env, true);
      const parent = createTrackedSurface(env, "startup-failure-parent");
      const bystander = createTrackedSurface(env, "startup-bystander");
      await waitForPaneReady(parent);
      await waitForPaneReady(bystander);
      runInPane(bystander, "printf 'STARTUP_BYSTANDER_UNTOUCHED\\n'");
      startPi(parent, env.dir, "Return exactly STARTUP_PARENT_READY", {
        extraArgs: `--session ${shellQuote(parentFile)} -e ${shellQuote(fixture.extension)}`,
      });
      await until(() => entries(parentFile).some(row => row.message?.role === "assistant"), "parent ready");
      runInPane(parent, 'Call the replicate tool once with name: "check-startup-failure" task: "Return exactly UNREACHABLE_STARTUP_ANSWER"');
      await until(() => existsSync(fixture.witness), "the inherited extension must execute in the replica");
      const failed: StartupWitness = JSON.parse(readFileSync(fixture.witness, "utf8"));
      const remaining = () => Math.max(1, failed.at + FAILURE_WINDOW_MS - Date.now());

      await until(() => outcomes(parentFile).length > 0, "startup failure must reach its immediate parent promptly", remaining());
      const received = outcomes(parentFile);
      assert.equal(received.length, 1);
      assert.match(outcomeText(received[0]), new RegExp(MISSING_MODULE), "the host must receive the actual module-load diagnostic, not generic process loss");
      assert.doesNotMatch(outcomeText(received[0]), /STARTUP_PARENT_READY/, "the inherited parent answer is not a replica result");
      if (received[0].customType === "subagent_result") {
        assert.equal(received[0].details.exitCode, 1);
        assert.equal(received[0].details.integration.status, "not-attempted");
      }
      assert.equal(await waitForPaneAbsence(failed.paneId, { timeoutMs: remaining(), intervalMs: 50 }), true, "the failed attempt pane must close without child initialization");
      assert.deepEqual(await waitForProcessesExit([failed.pid], { timeoutMs: remaining() }), [], "the failed Pi process must be gone");
      assert.ok(Date.now() - failed.at < FAILURE_WINDOW_MS, "delivery and pane cleanup must not wait for an idle/recovery deadline");
      assert.equal(existsSync(fixture.registered), false, "the extension failed before any child session_start handler ran");
      assert.equal(getProviderRequests().some(request => request.userText.includes("Your assignment:\nReturn exactly UNREACHABLE_STARTUP_ANSWER")), false, "a failed bootstrap must not start the replica model");
      assert.notEqual(failed.cwd, env.dir);
      assert.equal(readFileSync(join(failed.cwd, "startup-partial.txt"), "utf8"), "STARTUP_PARTIAL_SOURCE", "failed source must remain recoverable after its pane closes");
      assert.equal(existsSync(join(env.dir, "startup-partial.txt")), false, "failed work must not be integrated into the parent");
      assert.match(await readPaneAsync(bystander, 20), /STARTUP_BYSTANDER_UNTOUCHED/, "unrelated panes must stay open");

      runInPane(parent, "/reload");
      await waitForScreen(parent, /Reloaded keybindings, extensions/, 30_000);
      runInPane(parent, "Return exactly STARTUP_FAILURE_RELOAD_READY");
      await until(() => entries(parentFile).some(row => row.message?.role === "assistant" && JSON.stringify(row.message.content).includes("STARTUP_FAILURE_RELOAD_READY")), "the parent must remain usable after replaying launch evidence");
      assert.equal(outcomes(parentFile).length, 1, "reattachment must not report the same failed launch twice");
    });

    it("keeps a warning-only replica alive until its normal result", async () => {
      const parentFile = join(env.dir, "parent.jsonl");
      const fixture = startupFixture(env, false);
      const gate = join(env.dir, ".pi", "agent", "release-warning-copy");
      const parent = createTrackedSurface(env, "startup-warning-parent");
      await waitForPaneReady(parent);
      startPi(parent, env.dir, "Return exactly WARNING_PARENT_READY", {
        extraArgs: `--session ${shellQuote(parentFile)} -e ${shellQuote(fixture.extension)}`,
      });
      await until(() => entries(parentFile).some(row => row.message?.role === "assistant"), "parent ready");
      runInPane(parent, `Call the replicate tool once with name: "check-startup-warning" task: ${JSON.stringify(`INTEGRATION_WAIT_FOR_FILE: ${gate} Return exactly STOP_CHILD_SUMMARY`)}`);
      try {
        await until(() => existsSync(fixture.witness) && existsSync(fixture.registered), "warning-only startup must reach the child's session_start");
        const started: StartupWitness = JSON.parse(readFileSync(fixture.witness, "utf8"));
        // Cross the completion observer's one-second polling interval while the model is held.
        await sleep(1500);
        assert.equal(outcomes(parentFile).length, 0, "a warning is not a terminal failure");
        assert.equal(existsSync(`/proc/${started.pid}`), true, "the warning-only copy must still be alive");
        assert.ok(getProviderRequests().some(request => request.userText.includes("Your assignment:") && request.userText.includes("STOP_CHILD_SUMMARY")), "the warning-only copy must reach its model request");
        writeFileSync(gate, "release");
        await until(() => outcomes(parentFile).length > 0, "the normally finished replica must return");
        const received = outcomes(parentFile);
        assert.equal(received.length, 1);
        assert.equal(received[0].customType, "subagent_result");
        assert.equal(received[0].details.exitCode, 0);
        assert.match(outcomeText(received[0]), /STOP_CHILD_SUMMARY/);
        assert.equal(await waitForPaneAbsence(started.paneId, { timeoutMs: 10_000 }), true);
      } finally { writeFileSync(gate, "release"); }
    });
  });
}
