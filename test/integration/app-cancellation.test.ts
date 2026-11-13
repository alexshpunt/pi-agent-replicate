import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { appendLineageEvent, reduceLineage } from "../../pi-extension/subagents/lineage.ts";
import { TEST_PROVIDER_URL } from "./fake-provider.ts";

// This requires the caller's separate test-owned App and Core, never the normal desktop.
const sandbox = process.env.PI_APP_TEST_SANDBOX;
test("cancelling a live App replica retires its terminal without touching its parent", { skip: !sandbox, timeout: 120_000 }, async () => {
  assert.ok(sandbox && sandbox.startsWith("/"));
  const app = process.env.PI_APP_TEST_BIN; assert.ok(app && app.startsWith("/"));
  const coreSession = process.env.PI_APP_TEST_SESSION; assert.ok(coreSession && coreSession !== "default");
  const root = resolve(sandbox), env: NodeJS.ProcessEnv = { ...process.env, XDG_RUNTIME_DIR: join(root, "runtime"), XDG_CONFIG_HOME: join(root, "config"), XDG_STATE_HOME: join(root, "state"), XDG_DATA_HOME: join(root, "data"), HERDR_APP_HOME: join(root, "app"), HC_SESSION: coreSession };
  for (const key of ["HC_SOCKET", "HC_TERMINAL_SOCKET", "HC_TERMINAL_ID", "HC_SCOPE", "HERDR_ENV", "PI_TELEPORT_APP_CONTEXT"]) delete env[key];
  const run = (bin: string, ...args: string[]) => execFileSync(bin, args, { env, encoding: "utf8", timeout: 20000 });
  const hc = (...args: string[]) => run("hc", ...args);
  const dir = mkdtempSync(join(root, "cancel-case-")), repo = join(dir, "repo"), agent = join(dir, "agent"), session = join(dir, "parent.jsonl");
  mkdirSync(repo); mkdirSync(agent);
  const git = (...args: string[]) => execFileSync("git", args, { cwd: repo, encoding: "utf8" });
  const quote = (value: string) => "'" + value.replaceAll("'", "'\\''") + "'";
  git("init", "-q"); git("config", "user.name", "Test"); git("config", "user.email", "test@example.invalid");
  writeFileSync(join(repo, "file"), "base\n"); git("add", "file"); git("commit", "-qm", "base");
  writeFileSync(join(agent, "settings.json"), JSON.stringify({ defaultProjectTrust: "always" }));
  writeFileSync(join(agent, "replicate.json"), JSON.stringify({ directoryMode: "worktree" }));
  writeFileSync(join(agent, "models.json"), JSON.stringify({ providers: { "pi-integration": { baseUrl: TEST_PROVIDER_URL, api: "openai-completions", apiKey: "test", compat: { supportsDeveloperRole: false, supportsReasoningEffort: false, supportsUsageInStreaming: false }, models: [{ id: "test", name: "Fixture", reasoning: true, input: ["text"], contextWindow: 128000, maxTokens: 4096, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }] } } }));
  const parent = JSON.parse(run(app, "do", "space.new", JSON.stringify({ name: "cancel-parent", folder: repo, machine: "" })));
  try {
    const prompt = 'INTEGRATION_VISUAL_PARENT. Call the replicate tool once with name: "cancel-copy" task: "INTEGRATION_ALWAYS_QUIET"';
    const pi = process.env.PI_APP_TEST_PI_BIN ?? "pi", extension = resolve("pi-extension/subagents/index.ts");
    const command = `env PI_CODING_AGENT_DIR=${quote(agent)} PI_HERDR_APP_CLI=${quote(app)} PATH=${quote(process.env.PATH ?? "")} ${quote(pi)} -ne -e ${quote(extension)} --model pi-integration/test --session ${quote(session)} ${quote(prompt)}`;
    hc("send", parent.terminal, `bash -lc ${quote(command)}`);
    const deadline = Date.now() + 90000; let childId = "", lineage = "", surface = "";
    while (Date.now() < deadline) {
      if (existsSync(session)) {
        const entries = readFileSync(session, "utf8").split("\n").filter(Boolean).map(line => { try { return JSON.parse(line); } catch { return null; } });
        const failed = entries.find(row => row?.message?.role === "toolResult" && row.message.isError);
        if (failed) assert.fail(JSON.stringify(failed.message.content));
        const launched = entries.find(row => row?.message?.role === "toolResult" && row.message.toolName === "replicate" && row.message.details?.id);
        childId = launched?.message?.details?.id ?? "";
        if (childId) {
          const record = join(agent, "subagent-sessions", "replicas", `${childId}.json`);
          const lineageDir = join(record + ".artifacts", "launch", "lineage");
          if (existsSync(lineageDir)) {
            const name = readdirSync(lineageDir)[0];
            if (name) {
              lineage = join(lineageDir, name);
              const node = reduceLineage(lineage).nodes.get(childId);
              surface = node?.surface ?? "";
              if (surface && existsSync(join(lineage, "locations", `${childId}.json`))) break;
            }
          }
        }
      }
      await new Promise(resolve => setTimeout(resolve, 150));
    }
    assert.ok(childId && lineage && surface, "replica did not start");
    assert.ok(appendLineageEvent(lineage, `cancel-intent:${childId}`, "cancel_intent", childId, { surface }));
    let cancelled = false;
    while (Date.now() < deadline) {
      const node = reduceLineage(lineage).nodes.get(childId);
      if (node?.cancellation?.proven && node.terminal?.outcome === "cancelled") { cancelled = true; break; }
      await new Promise(resolve => setTimeout(resolve, 250));
    }
    assert.ok(cancelled, "cancellation was not proven");
    const recordFile = join(agent, "subagent-sessions", "replicas", `${childId}.json`);
    let record: any;
    while (Date.now() < deadline) {
      record = JSON.parse(readFileSync(recordFile, "utf8"));
      if (record.cleaned) break;
      await new Promise(resolve => setTimeout(resolve, 250));
    }
    assert.equal(record.cleaned, true);
    assert.ok(existsSync(record.worktree.path), "cancelled work must remain available");
    assert.equal(JSON.parse(hc("get", parent.terminal)).state, "live");
    assert.throws(() => hc("get", surface));
  } finally {
    run(app, "do", "terminal.park", JSON.stringify({ terminal: parent.terminal }));
    hc("kill", parent.terminal);
    hc("rm", parent.terminal);
  }
});
