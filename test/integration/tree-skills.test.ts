import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, it } from "node:test";
import { getProviderRequests, resetProviderRequests } from "./fake-provider.ts";
import {
  PI_TIMEOUT, cleanupTestEnv, createTestEnv, createTrackedSurface, getAvailableBackends,
  readPane, restoreBackend, setBackend, sleep, startPi, waitForPaneReady, waitForScreen,
  type TestEnv,
} from "./harness.ts";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../index.js");

function writeSkill(root: string, name: string, body: string): void {
  const directory = join(root, ".pi", "skills", name);
  mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, "SKILL.md"), `---\nname: ${name}\ndescription: Integration fixture\n---\n\n${body}\n`);
}

function writeRole(root: string, name: string, skills: string): void {
  const directory = join(root, ".pi", "agents");
  mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, `${name}.md`), `---\nname: ${name}\ndescription: Integration fixture\nmodel: pi-integration/test\ntools: read\nskills: ${skills}\nauto-exit: true\n---\nReturn the requested result.\n`);
}

async function waitForFile(path: string, failure: string, surface: string): Promise<any> {
  const deadline = Date.now() + PI_TIMEOUT;
  while (Date.now() < deadline) {
    if (existsSync(failure)) throw new Error(readFileSync(failure, "utf8"));
    if (existsSync(path)) return JSON.parse(readFileSync(path, "utf8"));
    const screen = readPane(surface, 300);
    if (/__TEST_DONE_\d+__/.test(screen)) throw new Error(`Parent exited before child result:\n${screen}`);
    await sleep(50);
  }
  throw new Error(`Timed out waiting for ${path}:\n${readPane(surface, 300)}`);
}

async function waitForChildPane(workspaceId: string, label: string): Promise<string> {
  const deadline = Date.now() + PI_TIMEOUT;
  while (Date.now() < deadline) {
    const panes = JSON.parse(execFileSync("herdr", ["pane", "list", "--workspace", workspaceId], { encoding: "utf8" })).result.panes;
    const pane = panes.find((item: { label?: string; pane_id?: string }) => item.label === label && item.pane_id);
    if (pane) return pane.pane_id;
    await sleep(50);
  }
  throw new Error(`Timed out waiting for child pane ${label}`);
}

interface Scenario {
  roleSkills: string;
  override?: string;
  expectedBodies: string[];
  absentBodies: string[];
  missingSkill?: string;
}

for (const backend of getAvailableBackends()) {
  describe(`public tree skill initialization [${backend}]`, { timeout: PI_TIMEOUT * 4 }, () => {
    let previousBackend: string | undefined;
    let env: TestEnv;
    let gate: string | undefined;

    beforeEach(() => {
      previousBackend = setBackend(backend);
      env = createTestEnv(backend);
      resetProviderRequests();
    });
    afterEach(async () => {
      if (gate) { try { writeFileSync(gate, "release"); } catch {} }
      gate = undefined;
      await cleanupTestEnv(env);
      restoreBackend(previousBackend);
    });

    async function runScenario(scenario: Scenario): Promise<void> {
      const id = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
      const report = `SKILL_REPORT_${id.replaceAll("-", "_")}`;
      const role = `skill-role-${id}`;
      const childName = `SkillChild-${id}`;
      for (const [name, body] of [["tree-first", "FIRST_BODY_MARKER"], ["tree-second", "SECOND_BODY_MARKER"], ["tree-direct", "DIRECT_BODY_MARKER"]]) writeSkill(env.dir, name, body);
      writeRole(env.dir, role, scenario.roleSkills);
      const resultFile = join(env.dir, "tree-result.json");
      const failureFile = join(env.dir, "tree-failure.txt");
      const gateFile = join(env.dir, "skill-release");
      gate = gateFile;
      const task = scenario.missingSkill ? `INTEGRATION_WAIT_FOR_FILE: ${gateFile} Return exactly ${report}` : `Return exactly ${report}`;
      const extension = join(env.dir, "tree-skills-consumer.ts");
      const launchOptions = { name: childName, agent: role, task, tools: ["read"], ...(scenario.override !== undefined ? { skills: scenario.override } : {}) };
      writeFileSync(extension, `import { renameSync, writeFileSync } from "node:fs";
import { createSubagentTree } from ${JSON.stringify(packageRoot)};
export default function(pi) {
  pi.registerTool({ name: "consumer_tree_metadata_probe", label: "Tree fixture", description: "Launch a child", parameters: { type: "object", properties: {}, additionalProperties: false },
    async execute(_id, _params, _signal, _update, ctx) {
      try {
        const tree = createSubagentTree({ pi, ctx });
        const child = await tree.launchChild({ parentId: tree.callerId, ...${JSON.stringify(launchOptions)} });
        void Promise.all([tree.result, child.result]).then(([terminal, result]) => { const path = ${JSON.stringify(resultFile)}; writeFileSync(path + ".tmp", JSON.stringify({ terminal, result })); renameSync(path + ".tmp", path); }, error => writeFileSync(${JSON.stringify(failureFile)}, String(error?.stack ?? error)));
        return { content: [{ type: "text", text: "launched" }], details: {} };
      } catch (error) { writeFileSync(${JSON.stringify(failureFile)}, String(error?.stack ?? error)); throw error; }
    }
  });
}
`);
      const parent = createTrackedSurface(env, `tree-skills-parent-${id}`);
      await waitForPaneReady(parent);
      startPi(parent, env.dir, "Call consumer_tree_metadata_probe exactly once, then wait.", {
        extensionSource: extension, environment: { JITI_FS_CACHE: "0" }, extraArgs: "--tools consumer_tree_metadata_probe",
      });
      if (scenario.missingSkill) {
        const childPane = await waitForChildPane(env.workspaceId, childName);
        try {
          const screen = await waitForScreen(childPane, new RegExp(scenario.missingSkill), PI_TIMEOUT, 300);
          assert.ok(screen.includes(scenario.missingSkill));
        } finally { writeFileSync(gateFile, "release"); }
      }
      const { terminal, result } = await waitForFile(resultFile, failureFile, parent);
      assert.equal(terminal.state, "completed");
      assert.deepEqual(result, terminal.rootResult);
      assert.equal(result.outcome, "clean");
      assert.equal(result.answer, report);
      assert.equal(typeof result.sessionReference, "string");
      const childEntries = readFileSync(result.sessionReference, "utf8").trim().split("\n").map(line => JSON.parse(line));
      const requests = getProviderRequests().filter(request => request.text.includes(report));
      assert.equal(requests.length, 1, "the child task and initialized skills share its first request");
      for (const body of scenario.expectedBodies) assert.equal(requests[0].text.split(body).length - 1, 1, `${body} must occur exactly once`);
      for (const body of scenario.absentBodies) assert.equal(requests[0].text.includes(body), false);
      assert.equal(JSON.stringify(childEntries).includes("/skill:"), false);
      if (scenario.missingSkill) {
        assert.equal(requests[0].text.includes(scenario.missingSkill), false);
        assert.equal(JSON.stringify(childEntries.filter((entry: any) => entry.type === "message" && entry.message?.role === "assistant")).includes(scenario.missingSkill), false);
        assert.equal(JSON.stringify({ terminal, result }).includes(scenario.missingSkill), false);
      }
    }

    it("loads each role skill into the child's first request", async () => {
      await runScenario({ roleSkills: "tree-first,tree-second", expectedBodies: ["FIRST_BODY_MARKER", "SECOND_BODY_MARKER"], absentBodies: ["DIRECT_BODY_MARKER"] });
    });
    it("deduplicates explicit skills, replaces role skills, and keeps missing-skill warnings out of results", async () => {
      await runScenario({ roleSkills: "tree-first", override: "tree-direct, tree-missing, tree-direct, tree-missing", expectedBodies: ["DIRECT_BODY_MARKER"], absentBodies: ["FIRST_BODY_MARKER"], missingSkill: "tree-missing" });
    });
    it("uses an explicit empty override to disable role skills", async () => {
      await runScenario({ roleSkills: "tree-first", override: "", expectedBodies: [], absentBodies: ["FIRST_BODY_MARKER", "SECOND_BODY_MARKER", "DIRECT_BODY_MARKER"] });
    });
  });
}
