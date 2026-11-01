import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, it } from "node:test";
import { getProviderRequests, resetProviderRequests } from "./fake-provider.ts";
import {
  PI_TIMEOUT, cleanupTestEnv, createTestEnv, createTrackedSurface, getAvailableBackends,
  readPane, restoreBackend, setBackend, sleep, startPi, waitForPaneReady, type TestEnv,
} from "./harness.ts";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../index.js");

function resources(env: TestEnv): { paneIds: string[]; workspaceIds: string[] } {
  const panes = JSON.parse(execFileSync("herdr", ["pane", "list", "--workspace", env.workspaceId], { encoding: "utf8" })).result.panes;
  const workspaces = JSON.parse(execFileSync("herdr", ["workspace", "list"], { encoding: "utf8" })).result.workspaces;
  return {
    paneIds: panes.map((pane: { pane_id: string }) => pane.pane_id).sort(),
    workspaceIds: workspaces.map((workspace: { workspace_id: string }) => workspace.workspace_id).sort(),
  };
}

async function waitForResult(file: string, parent: string): Promise<any> {
  const deadline = Date.now() + PI_TIMEOUT;
  while (Date.now() < deadline) {
    if (existsSync(file)) return JSON.parse(readFileSync(file, "utf8"));
    const screen = readPane(parent, 100);
    if (/__TEST_DONE_\d+__/.test(screen)) throw new Error(`Parent exited before recording validation: ${screen}`);
    await sleep(50);
  }
  throw new Error(`Timed out waiting for validation: ${readPane(parent, 100)}`);
}

for (const backend of getAvailableBackends()) {
  describe(`public tree unknown role [${backend}]`, { timeout: PI_TIMEOUT * 2 }, () => {
    let env: TestEnv;
    let previousBackend: string | undefined;
    beforeEach(() => { previousBackend = setBackend(backend); env = createTestEnv(backend); resetProviderRequests(); });
    afterEach(async () => { await cleanupTestEnv(env); restoreBackend(previousBackend); });

    it("rejects an unknown explicit role before creating a child", async () => {
      const id = randomUUID();
      const role = `missing-role-${id}`;
      const task = `UNKNOWN_ROLE_TASK_${id}`;
      const result = join(env.dir, "role-validation.json");
      const extension = join(env.dir, "unknown-role-consumer.ts");
      writeFileSync(extension, `import { renameSync, writeFileSync } from "node:fs";
import { createSubagentTree, SubagentTreeValidationError } from ${JSON.stringify(packageRoot)};
export default function(pi) {
  pi.registerTool({ name: "consumer_tree_metadata_probe", label: "Tree fixture", description: "Check role validation", parameters: { type: "object", properties: {}, additionalProperties: false },
    async execute(_id, _params, _signal, _update, ctx) {
      const tree = createSubagentTree({ pi, ctx });
      let rejected = false, validationError = false;
      try { await tree.launchChild({ parentId: tree.callerId, name: "unknown-role-child", agent: ${JSON.stringify(role)}, task: ${JSON.stringify(task)}, tools: ["read"] }); }
      catch (error) { rejected = true; validationError = error instanceof SubagentTreeValidationError; }
      const result = ${JSON.stringify(result)};
      writeFileSync(result + ".tmp", JSON.stringify({ rejected, validationError, childCount: tree.children.size }));
      renameSync(result + ".tmp", result);
      return { content: [{ type: "text", text: "checked" }], details: {} };
    }
  });
}
`);
      const parent = createTrackedSurface(env, `unknown-role-parent-${id}`);
      await waitForPaneReady(parent);
      const before = resources(env);
      startPi(parent, env.dir, "Call consumer_tree_metadata_probe exactly once, then wait.", {
        extensionSource: extension, environment: { JITI_FS_CACHE: "0" }, extraArgs: "--tools consumer_tree_metadata_probe",
      });
      const actual = await waitForResult(result, parent);
      assert.deepEqual(actual, { rejected: true, validationError: true, childCount: 0 });
      assert.deepEqual(resources(env), before, "validation must not create a pane or workspace");
      assert.equal(getProviderRequests().some(request => request.userText.includes(task)), false, "validation must not start a child model request");
    });
  });
}
