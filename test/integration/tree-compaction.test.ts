import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, it } from "node:test";
import { readSessionBinding } from "../../pi-extension/subagents/session-binding.ts";
import {
  PI_TIMEOUT, cleanupTestEnv, createTestEnv, createTrackedSurface,
  getAvailableBackends, readPane, restoreBackend, runInPane, setBackend,
  sleep, startPi, waitForPaneReady, type TestEnv,
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

async function waitForChildSession(root: string, childId: string): Promise<string> {
  const sessions = join(root, ".pi", "agent", "sessions");
  const deadline = Date.now() + PI_TIMEOUT;
  while (Date.now() < deadline) {
    if (existsSync(sessions)) {
      for (const directory of readdirSync(sessions, { withFileTypes: true })) {
        if (!directory.isDirectory()) continue;
        const file = readdirSync(join(sessions, directory.name)).find((name) => name.includes(childId) && name.endsWith(".jsonl"));
        if (file) return join(sessions, directory.name, file);
      }
    }
    await sleep(25);
  }
  throw new Error(`Timeout waiting for session for child ${childId}`);
}

for (const backend of backends) {
  describe(`public tree manual compaction [${backend}]`, { timeout: PI_TIMEOUT * 5 }, () => {
    let previous: string | undefined;
    let env: TestEnv;
    beforeEach(() => { previous = setBackend(backend); env = createTestEnv(backend); });
    afterEach(async () => { await cleanupTestEnv(env); restoreBackend(previous); });

    it("keeps a persistent child active until manual compaction finishes without delivering a result", async () => {
      const id = `tree-compact-${Date.now()}`;
      const label = `Compaction-${id}`;
      const agentDir = join(env.dir, ".pi", "agent");
      const gate = join(agentDir, "integration-compaction-release");
      const launched = join(env.dir, "launched.json");
      const result = join(env.dir, "result.json");
      const callback = join(env.dir, "callback.json");
      const extension = join(env.dir, "tree-compaction-extension.ts");
      writeFileSync(join(env.dir, ".pi", "settings.json"), JSON.stringify({ compaction: { keepRecentTokens: 1 } }));
      writeFileSync(join(agentDir, "integration-compaction-enabled"), "enabled\n");
      writeFileSync(extension, `
import { writeFileSync } from "node:fs";
import { Type } from ${JSON.stringify(join(root, "node_modules/@sinclair/typebox/build/esm/index.mjs"))};
import { createSubagentTree } from ${JSON.stringify(join(root, "index.ts"))};
export default function(pi) {
  pi.registerTool({ name: "consumer_tree_open_probe", label: "Launch", description: "Launch persistent test child", parameters: Type.Object({}),
    async execute(_id, _params, _signal, _update, ctx) {
      const tree = createSubagentTree({ pi, ctx });
      tree.bindFinalCallback(value => writeFileSync(${JSON.stringify(callback)}, JSON.stringify(value)));
      const child = await tree.launchChild({ parentId: tree.callerId, name: ${JSON.stringify(label)}, agent: "test-persistent", task: ${JSON.stringify(`Return exactly CHILD_READY_${id}`)}, tools: ["read", "bash", "write", "edit"] });
      void child.result.then(value => writeFileSync(${JSON.stringify(result)}, JSON.stringify(value)));
      writeFileSync(${JSON.stringify(launched)}, JSON.stringify({ childId: child.nodeId }));
      return { content: [{ type: "text", text: "child launched" }], details: {} };
    }
  });
}`);
      const parent = createTrackedSurface(env, `parent-${id}`);
      await waitForPaneReady(parent);
      startPi(parent, env.dir, "Call consumer_tree_open_probe exactly once, then wait.", {
        extensionSource: extension,
        environment: { JITI_FS_CACHE: "0", PI_SUBAGENT_QUIET_THRESHOLD_MS: "200" },
        extraArgs: "--tools consumer_tree_open_probe",
      });
      const { childId } = JSON.parse(await waitForFile(launched, parent)) as { childId: string };
      const active = await waitForActivity(env.dir, childId, (value) =>
        (value.latestEvent === "agent_end" || value.latestEvent === "agent_settled") && value.phase === "waiting");
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
      assert.equal(existsSync(result), false, "compaction must not settle the child");
      assert.equal(existsSync(callback), false, "compaction must not publish a tree result");

      writeFileSync(gate, "release\n");
      const compacted = await waitForActivity(env.dir, childId, (value) => value.latestEvent === "session_compact" && value.compactionActive === false);
      assert.equal(compacted.path, compacting.path);
      assert.equal(compacted.activity.phase, "waiting");
      assert.equal(compacted.activity.activeScope, undefined);
      assert.equal(compacted.activity.turnActive, false);
      assert.equal(compacted.activity.providerActive, false);
      assert.equal(compacted.activity.toolActive, false);
      const childSession = await waitForChildSession(env.dir, childId);
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
      assert.equal(existsSync(result), false);
      assert.equal(existsSync(callback), false);
    });
  });
}
