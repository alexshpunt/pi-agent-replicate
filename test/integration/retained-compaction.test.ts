import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, it } from "node:test";
import { readSessionBinding } from "../../pi-extension/subagents/session-binding.ts";
import { reduceLineage } from "../../pi-extension/subagents/lineage.ts";
import {
  PI_TIMEOUT, cleanupTestEnv, createTestEnv, createTrackedSurface,
  getAvailableBackends, readPane, restoreBackend, runInPane, setBackend,
  shellQuote, sleep, startPi, waitForPaneReady, type TestEnv,
} from "./harness.ts";

const root = join(dirname(fileURLToPath(import.meta.url)), "../..");
const backends = getAvailableBackends();

type Activity = {
  runningChildId?: string; latestEvent?: string; phase?: string;
  compactionActive?: boolean; compactionReason?: string; compactionWillRetry?: boolean;
  activeScope?: string; activeSince?: number; turnActive?: boolean;
  providerActive?: boolean; toolActive?: boolean;
};

function activityFiles(root: string): string[] {
  const artifacts = join(root, "artifacts");
  if (!existsSync(artifacts)) return [];
  return readdirSync(artifacts, { withFileTypes: true }).flatMap((session) => {
    const directory = join(artifacts, session.name, "subagent-activity");
    if (!session.isDirectory() || !existsSync(directory)) return [];
    return readdirSync(directory).filter((name) => name.endsWith(".json")).map((name) => join(directory, name));
  });
}

async function waitForActivity(root: string, childId: string, predicate: (activity: Activity) => boolean): Promise<{ path: string; activity: Activity }> {
  const deadline = Date.now() + PI_TIMEOUT;
  let last: Activity | undefined;
  while (Date.now() < deadline) {
    for (const path of activityFiles(root)) {
      try {
        const activity = JSON.parse(readFileSync(path, "utf8")) as Activity;
        if (activity.runningChildId !== childId) continue;
        last = activity;
        if (predicate(activity)) return { path, activity };
      } catch { /* A sidecar may be replaced while it is read. */ }
    }
    await sleep(25);
  }
  throw new Error(`Timeout waiting for child activity; last=${JSON.stringify(last)}`);
}

function panes(workspaceId: string): Array<{ pane_id?: string; label?: string }> {
  return JSON.parse(execFileSync("herdr", ["pane", "list", "--workspace", workspaceId], { encoding: "utf8" })).result.panes;
}

async function waitForFile(path: string, parentPane: string): Promise<string> {
  const deadline = Date.now() + PI_TIMEOUT;
  while (Date.now() < deadline) {
    if (existsSync(path)) return readFileSync(path, "utf8");
    await sleep(50);
  }
  throw new Error(`Timeout waiting for ${path}; parent screen:\n${readPane(parentPane, 100)}`);
}


for (const backend of backends) {
  describe(`retained child manual compaction [${backend}]`, { timeout: PI_TIMEOUT * 5 }, () => {
    let previous: string | undefined;
    let env: TestEnv;
    beforeEach(() => { previous = setBackend(backend); env = createTestEnv(backend); });
    afterEach(async () => {
      // Release a held compaction even when an assertion fails before cleanup.
      try { writeFileSync(join(env.dir, ".pi", "agent", "integration-compaction-release"), "release\n"); } catch { /* Setup may not have completed. */ }
      await cleanupTestEnv(env);
      restoreBackend(previous);
    });

    it("keeps a persistent child active until manual compaction finishes without delivering a result", async () => {
      const id = `tree-compact-${Date.now()}`;
      const label = `Compaction-${id}`;
      const agentDir = join(env.dir, ".pi", "agent");
      const gate = join(agentDir, "integration-compaction-release");
      const launched = join(env.dir, "launched.json");
      const parentSession = join(env.dir, "parent.jsonl");
      const extension = join(env.dir, "tree-compaction-extension.ts");
      writeFileSync(join(env.dir, ".pi", "settings.json"), JSON.stringify({ compaction: { keepRecentTokens: 1 } }));
      writeFileSync(join(agentDir, "integration-compaction-enabled"), "enabled\n");
      // Exercise the retained watcher directly; persistent children are not a public tree lifecycle.
      writeFileSync(extension, `
import { appendFileSync, existsSync, writeFileSync } from "node:fs";
import { __test__ } from ${JSON.stringify(join(root, "pi-extension/subagents/index.ts"))};
export default function(pi) {
  pi.on("session_start", async (_event, ctx) => {
    if (process.env.PI_SUBAGENT_ID) return;
    const file = ${JSON.stringify(launched)};
    if (!existsSync(file)) {
      const child = await __test__.launchSubagent({ name: ${JSON.stringify(label)}, agent: "test-persistent", interactive: false, task: ${JSON.stringify(`Return exactly CHILD_READY_${id}`)} }, ctx, pi.getThinkingLevel());
      __test__.startRecoveredWatcher(child);
      writeFileSync(file, JSON.stringify({ childId: child.id, sessionFile: child.sessionFile, rootDir: child.lineage.rootDir }));
    }
    appendFileSync(file + ".starts", "start\\n");
  });
}`);
      const parent = createTrackedSurface(env, `parent-${id}`);
      await waitForPaneReady(parent);
      startPi(parent, env.dir, "Return exactly COMPACTION_PARENT_READY", {
        environment: { JITI_FS_CACHE: "0", PI_SUBAGENT_QUIET_THRESHOLD_MS: "200" },
        // Activity sidecars are relative to the parent session directory.
        extraArgs: `--session ${shellQuote(parentSession)} -e ${shellQuote(extension)}`,
      });
      const { childId, sessionFile, rootDir } = JSON.parse(await waitForFile(launched, parent)) as { childId: string; sessionFile: string; rootDir: string };
      const parentResults = () => {
        if (!existsSync(parentSession)) return [];
        const source = readFileSync(parentSession, "utf8");
        return source.slice(0, source.lastIndexOf("\n") + 1).split("\n").filter(Boolean).map((line) => JSON.parse(line)).filter((entry) => entry.customType === "subagent_result");
      };
      const assertNotDelivered = () => {
        assert.equal(parentResults().length, 0, "compaction must not publish a parent result");
        const node = reduceLineage(rootDir).nodes.get(childId);
        assert.ok(node, "the original child must remain in the lineage");
        assert.equal(node.terminal, undefined, "compaction must not settle the child");
      };
      // A reload starts production status supervision for the already launched child.
      await waitForActivity(env.dir, childId, (value) => (value.latestEvent === "agent_end" || value.latestEvent === "agent_settled") && value.phase === "waiting");
      runInPane(parent, "/reload");
      const starts = launched + ".starts";
      const deadline = Date.now() + PI_TIMEOUT;
      while ((!existsSync(starts) || readFileSync(starts, "utf8").trim().split("\n").length < 2) && Date.now() < deadline) await sleep(25);
      assert.equal(readFileSync(starts, "utf8").trim().split("\n").length, 2, "parent runtime reloaded and restored supervision");
      let active: Awaited<ReturnType<typeof waitForActivity>>;
      try {
        active = await waitForActivity(env.dir, childId, (value) =>
          (value.latestEvent === "agent_end" || value.latestEvent === "agent_settled") && value.phase === "waiting");
      } catch (error) {
        const childResult = parentResults();
        const childPane = panes(env.workspaceId).find((pane) => pane.label === label)?.pane_id;
        throw new Error(`${String(error)}\nchild=${childId} result=${childResult}\nparent:\n${readPane(parent, 100)}\nchild:\n${childPane ? readPane(childPane, 100) : "(no child pane)"}`);
      }
      assert.equal(active.activity.compactionActive, false);
      const childPane = panes(env.workspaceId).find((pane) => pane.label === label)?.pane_id;
      assert.ok(childPane, "persistent child must retain its original pane");

      runInPane(childPane, "/compact");
      const compacting = await waitForActivity(env.dir, childId, (value) =>
        value.latestEvent === "session_before_compact" && value.compactionActive === true && value.activeScope === "compaction");
      assert.equal(compacting.activity.compactionReason, "manual");
      assert.equal(compacting.activity.compactionWillRetry, false);
      assert.ok(compacting.activity.activeSince);
      const observed = await waitForActivity(env.dir, childId, (value) =>
        value.latestEvent === "session_before_compact" && value.compactionActive === true &&
        value.activeSince !== undefined && Date.now() - value.activeSince > 2_500);
      assert.equal(observed.path, compacting.path);
      assert.deepEqual(panes(env.workspaceId).filter((pane) => pane.label === label).map((pane) => pane.pane_id), [childPane]);
      assertNotDelivered();

      writeFileSync(gate, "release\n");
      const compacted = await waitForActivity(env.dir, childId, (value) => value.latestEvent === "session_compact" && value.compactionActive === false);
      assert.equal(compacted.path, compacting.path);
      assert.equal(compacted.activity.phase, "waiting");
      assert.equal(compacted.activity.activeScope, undefined);
      assert.equal(compacted.activity.turnActive, false);
      assert.equal(compacted.activity.providerActive, false);
      assert.equal(compacted.activity.toolActive, false);
      const childSession = sessionFile;
      const lineage = readSessionBinding(childSession)?.child?.lineage;
      assert.ok(lineage, "the child session must retain its lineage binding");
      const deliveryLog = join(lineage.rootDir, "subagent-delivery.log");
      assert.doesNotMatch(existsSync(deliveryLog) ? readFileSync(deliveryLog, "utf8") : "", /"event":"recovery-attempt"/, "compaction must not consume a recovery attempt");
      const entries = readFileSync(childSession, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line));
      const indices = entries.flatMap((entry, index) => entry.type === "compaction" ? [index] : []);
      assert.equal(indices.length, 1, "manual compaction must be saved once");
      assert.equal(indices[0], entries.length - 1, "compaction must not create an artificial follow-up turn");
      assert.equal(entries[indices[0]].summary, "INTEGRATION_COMPACTION_SUMMARY");
      assert.deepEqual(panes(env.workspaceId).filter((pane) => pane.label === label).map((pane) => pane.pane_id), [childPane]);
      assertNotDelivered();
    });
  });
}
