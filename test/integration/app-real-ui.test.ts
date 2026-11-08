import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { TEST_PROVIDER_URL } from "./fake-provider.ts";

// The caller must provision an isolated App window and core first; this test
// never falls back to a machine's normal App or Core connection.
const sandbox = process.env.PI_APP_TEST_SANDBOX;

test("a mod pane keeps its workspace when the replica terminal is parked", { skip: !sandbox, timeout: 60000 }, () => {
  assert.ok(sandbox && sandbox.startsWith("/"));
  const app = process.env.PI_APP_TEST_BIN; assert.ok(app && app.startsWith("/"));
  const coreSession = process.env.PI_APP_TEST_SESSION; assert.ok(coreSession && coreSession !== "default");
  const root = resolve(sandbox), env: NodeJS.ProcessEnv = { ...process.env, XDG_RUNTIME_DIR: join(root, "runtime"), XDG_CONFIG_HOME: join(root, "config"), XDG_STATE_HOME: join(root, "state"), XDG_DATA_HOME: join(root, "data"), HERDR_APP_HOME: join(root, "app"), HC_SESSION: coreSession };
  for (const key of ["HC_SOCKET", "HC_TERMINAL_SOCKET", "HC_TERMINAL_ID", "HC_SCOPE", "HERDR_ENV", "PI_TELEPORT_APP_CONTEXT"]) delete env[key];
  const run = (...args: string[]) => JSON.parse(execFileSync(app, args, { env, encoding: "utf8", timeout: 20000 }));
  const created = run("do", "space.new", JSON.stringify({ name: "replicate-mod-test", folder: root, machine: "", focus: false }));
  try {
    run("do", "tab.new", JSON.stringify({ space: created.space, mod: "changes", focus: false }));
    run("do", "terminal.park", JSON.stringify({ terminal: created.terminal }));
    const space = run("ls").spaces.find((item: any) => item.id === created.space);
    assert.ok(space);
    assert.ok(space.tabs.some((tab: any) => tab.terminals.length === 0));
  } finally {
    run("do", "space.close", JSON.stringify({ id: created.space, confirmed: true }));
    execFileSync("hc", ["kill", created.terminal], { env, timeout: 20000 });
    execFileSync("hc", ["rm", created.terminal], { env, timeout: 20000 });
  }
});
test("real App launches and joins a replica without changing the selected workspace", { skip: !sandbox, timeout: 120_000 }, async () => {
  assert.ok(sandbox && sandbox.startsWith("/"));
  const app = process.env.PI_APP_TEST_BIN; assert.ok(app && app.startsWith("/"));
  const coreSession = process.env.PI_APP_TEST_SESSION; assert.ok(coreSession && coreSession !== "default");
  const root = resolve(sandbox), env: NodeJS.ProcessEnv = { ...process.env, XDG_RUNTIME_DIR: join(root, "runtime"), XDG_CONFIG_HOME: join(root, "config"), XDG_STATE_HOME: join(root, "state"), XDG_DATA_HOME: join(root, "data"), HERDR_APP_HOME: join(root, "app"), HC_SESSION: coreSession };
  for (const key of ["HC_SOCKET", "HC_TERMINAL_SOCKET", "HC_TERMINAL_ID", "HC_SCOPE", "HERDR_ENV", "PI_TELEPORT_APP_CONTEXT"]) delete env[key];
  const run = (bin: string, ...args: string[]) => execFileSync(bin, args, { env, encoding: "utf8", timeout: 20000 });
  const hc = (...args: string[]) => run("hc", ...args);
  const core = JSON.parse(hc("server", "status", "--json")); assert.ok(core.pid && core.core.id);
  const dir = mkdtempSync(join(root, "pi-case-")), repo = join(dir, "repo"), agent = join(dir, "agent"), session = join(dir, "parent.jsonl");
  mkdirSync(repo); mkdirSync(agent);
  const git = (...args: string[]) => execFileSync("git", args, { cwd: repo, encoding: "utf8" });
  const quote = (value: string) => "'" + value.replaceAll("'", "'\\''") + "'";
  let pane = "";
  try {
    git("init", "-q"); git("config", "user.name", "Test"); git("config", "user.email", "test@example.invalid");
    writeFileSync(join(repo, "file"), "base\n"); git("add", "file"); git("commit", "-qm", "base");
    writeFileSync(join(agent, "settings.json"), JSON.stringify({ defaultProjectTrust: "always" }));
    writeFileSync(join(agent, "models.json"), JSON.stringify({ providers: { "pi-integration": { baseUrl: TEST_PROVIDER_URL, api: "openai-completions", apiKey: "test", compat: { supportsDeveloperRole: false, supportsReasoningEffort: false, supportsUsageInStreaming: false }, models: [{ id: "test", name: "Fixture", reasoning: true, input: ["text"], contextWindow: 128000, maxTokens: 4096, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }] } } }));
    const parent = JSON.parse(run(app, "do", "space.new", JSON.stringify({ name: "replicate-test-parent", folder: repo, machine: "" }))); pane = parent.terminal;
    const prompt = 'INTEGRATION_VISUAL_PARENT. Call the replicate tool once with name: "app-copy" task: "Return exactly APP_REPLICA_FINISHED"';
    const extension = resolve("pi-extension/subagents/index.ts");
    const pi = process.env.PI_APP_TEST_PI_BIN ?? "pi";
    const command = `env PI_CODING_AGENT_DIR=${quote(agent)} PI_HERDR_APP_CLI=${quote(app)} PATH=${quote(process.env.PATH ?? "")} ${quote(pi)} -ne -e ${quote(extension)} --model pi-integration/test --session ${quote(session)} ${quote(prompt)}`;
    hc("send", pane, `bash -lc ${quote(command)}`);
    const deadline = Date.now() + 90000; let result: any;
    while (Date.now() < deadline) {
      if (existsSync(session)) {
        const lines = readFileSync(session, "utf8").split("\n").filter(Boolean);
        const entries = lines.map(line => { try { return JSON.parse(line); } catch { return null; } });
        const failed = entries.find(row => row?.message?.role === "toolResult" && row.message.isError);
        if (failed) assert.fail(`Replica launch failed: ${JSON.stringify(failed.message.content)}`);
        result = entries.find(row => row?.customType === "subagent_result");
        if (result) break;
      }
      await new Promise(resolve => setTimeout(resolve, 150));
    }
    assert.ok(result, `No replica result; parent terminal:\n${hc("read", "--lines", "100", pane)}`);
    assert.equal(result.details.exitCode, 0);
    assert.equal(result.details.integration.status, "applied");
    assert.ok(result.details.resultContent.includes("APP_REPLICA_FINISHED"));
    const recordFile = join(agent, "subagent-sessions", "replicas", `${result.details.childId}.json`);
    const cleanupDeadline = Date.now() + 15000; let record: any;
    while (Date.now() < cleanupDeadline) {
      record = JSON.parse(readFileSync(recordFile, "utf8"));
      if (record.cleaned) break;
      await new Promise(resolve => setTimeout(resolve, 150));
    }
    assert.equal(record.cleaned, true);
    assert.equal(existsSync(record.worktree.path), false);
    assert.equal(existsSync(result.details.worktreePath), false);
    const status = JSON.parse(run(app, "status")); assert.equal(status.space, parent.space);
    assert.equal(JSON.parse(hc("get", pane)).state, "live");
  } finally {
    // The enclosing sandbox owns every process and workspace and is stopped by its owner.
    // Leave this directory until that owner shuts the sandbox down.
  }
});
