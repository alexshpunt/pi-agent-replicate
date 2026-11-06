import assert from "node:assert/strict";
import { test } from "node:test";
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync, readlinkSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { appCore } from "../../pi-extension/subagents/herdr-app.ts";
import { closePane, createSubagentPane, isTerminalAvailable, runScriptInPane, runInPane, shellQuote, waitForShellReady } from "../../pi-extension/subagents/terminal.ts";
import { TEST_PROVIDER_URL, getProviderRequests, resetProviderRequests, setProviderResponsePlan } from "./fake-provider.ts";

const delay = (ms: number) => new Promise(resolveWait => setTimeout(resolveWait, ms));
async function until(check: () => boolean, label: string, timeout = 60_000): Promise<void> {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) { if (check()) return; await delay(50); }
  throw new Error(label);
}
function rows(file: string): any[] {
  if (!existsSync(file)) return [];
  return readFileSync(file, "utf8").split("\n").filter(Boolean).flatMap(line => { try { return [JSON.parse(line)]; } catch { return []; } });
}
function content(value: unknown): string {
  return typeof value === "string" ? value : Array.isArray(value) ? value.map(part => part.text ?? "").join("\n") : "";
}

test("Replicate recognizes its verified native App terminal", () => {
  assert.equal(process.env.PI_INTEGRATION_BACKEND, "app");
  assert.ok(process.env.HC_TERMINAL_ID);
  assert.equal(isTerminalAvailable(), true);
});

for (const outcome of ["applied", "conflict", "failed", "empty", "shared"] as const) test(`native App replica delivers ${outcome} once and cleans only its owned runtime`, { timeout: 150_000 }, async () => {
  const runRoot = process.env.PI_INTEGRATION_HERDR_RUN_DIR!;
  assert.ok(runRoot);
  const root = join(runRoot, outcome), repo = join(root, "source-repo"), agent = join(root, "agent");
  mkdirSync(agent, { recursive: true });
  const evidence = process.env.PI_INTEGRATION_APP_EVIDENCE ? join(process.env.PI_INTEGRATION_APP_EVIDENCE, outcome) : undefined;
  const parentFile = join(root, "parent.jsonl"), witness = join(root, "starts.jsonl"), release = join(root, "release");
  const wrapper = join(root, "fixture.ts");
  const entry = process.env.PI_INTEGRATION_PI_ENTRY!;
  assert.ok(entry && existsSync(entry));
  mkdirSync(repo);
  const git = (...args: string[]) => execFileSync("git", args, { cwd: repo, encoding: "utf8" }).trim();
  git("init", "-b", "main"); git("config", "user.name", "Integration"); git("config", "user.email", "integration@example.invalid");
  writeFileSync(join(repo, "tracked.txt"), "COMMITTED_BASE\n");
  git("add", "."); git("commit", "-m", "Create fixture");
  writeFileSync(join(repo, "tracked.txt"), "APP_DIRTY_TRACKED\n");
  writeFileSync(join(repo, "context.txt"), "APP_UNTRACKED_CONTEXT\n");
  if (outcome === "shared") {
    writeFileSync(join(repo, ".gitignore"), "ignored.txt\n");
    writeFileSync(join(repo, "ignored.txt"), "APP_IGNORED_CONTEXT\n");
  }
  const head = git("rev-parse", "HEAD"), index = readFileSync(join(repo, ".git", "index"));
  writeFileSync(join(agent, "settings.json"), JSON.stringify({ defaultProjectTrust: "always" }));
  writeFileSync(join(agent, "models.json"), JSON.stringify({ providers: { "pi-integration": {
    baseUrl: TEST_PROVIDER_URL, api: "openai-completions", apiKey: "test",
    compat: { supportsDeveloperRole: false, supportsReasoningEffort: false, supportsUsageInStreaming: false },
    models: [{ id: "test", name: "Deterministic fixture", reasoning: false, input: ["text"], contextWindow: 128000, maxTokens: 4096, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }],
  } } }));
  const extension = fileURLToPath(new URL("../../pi-extension/subagents/index.ts", import.meta.url));
  writeFileSync(wrapper, `import replica from ${JSON.stringify(extension)};
import {appendFileSync} from 'node:fs';
export default async function(pi){await replica(pi); pi.on('session_start',(_event,ctx)=>appendFileSync(${JSON.stringify(witness)},JSON.stringify({pid:process.pid,cwd:process.cwd(),argv:process.argv,pane:process.env.HC_TERMINAL_ID,child:process.env.PI_SUBAGENT_ID,id:ctx.sessionManager.getSessionId(),file:ctx.sessionManager.getSessionFile()})+'\\n'));}
`);
  const branches = git("branch", "--list"), trees = git("worktree", "list", "--porcelain");
  let childKilled = false;
  resetProviderRequests();
  setProviderResponsePlan(async request => {
    const messages: any[] = request.messages ?? [];
    const user = content([...messages].reverse().find(message => message.role === "user")?.content);
    const calls = messages.flatMap(message => message.tool_calls ?? []).map(call => call.function?.name);
    if (childKilled || rows(parentFile).some(row => row.customType === "subagent_result")) return { text: "APP_NATIVE_PARENT_COMPLETE" };
    if (user === "APP_NATIVE_READY") return { text: "APP_NATIVE_READY_ACK" };
    if (user.includes("APP_NATIVE_CHILD_SUMMARY")) return { text: "APP_NATIVE_PARENT_COMPLETE" };
    if (user.includes("APP_NATIVE_PARENT_INDEPENDENT")) return { text: "APP_NATIVE_INDEPENDENT_DONE" };
    if (user.includes("APP_NATIVE_CHILD_TASK")) {
      if (!calls.includes("read")) return { toolCalls: [
        { name: "read", arguments: { path: "tracked.txt" } }, { name: "read", arguments: { path: "context.txt" } },
        ...(outcome === "shared" ? [{ name: "read", arguments: { path: "ignored.txt" } }] : []),
      ] };
      if (!calls.includes("write")) {
        if (outcome !== "failed") await until(() => existsSync(release), "The native child gate was not released.");
        return { toolCalls: [{ name: "write", arguments: { path: "app-result.txt", content: "APP_NATIVE_JOINED\n" } }] };
      }
      if (outcome === "failed") await until(() => existsSync(release), "The failed-child request was not released.");
      if (outcome === "empty") return { emptyCompletion: true };
      return { text: "APP_NATIVE_CHILD_SUMMARY" };
    }
    if (user.includes("APP_NATIVE_PARENT_START")) return calls.includes("replicate") ? { text: "APP_NATIVE_PARENT_ACK" } : {
      toolCalls: [{ name: "replicate", arguments: { name: "app-write-result", task: "APP_NATIVE_CHILD_TASK. Read the snapshot and save app-result.txt." } }],
    };
    throw new Error("Unexpected native fixture request: " + user);
  });
  let parent: string | undefined;
  const capture = async (name: string) => {
    if (!evidence || !parent) return;
    mkdirSync(evidence, { recursive: true });
    const binary = process.env.PI_INTEGRATION_APP_BIN!;
    const inspect = (command: string) => JSON.parse(execFileSync(binary, [command], { encoding: "utf8", timeout: 15_000 }));
    execFileSync(binary, ["do", "agent.focus", JSON.stringify({ terminal: parent })], { encoding: "utf8", timeout: 15_000 });
    let stable = 0;
    await until(() => {
      const world = inspect("ls"), status = inspect("status");
      assert.ok(!status.overlays.includes("frame-welcome"));
      const space = world.spaces.find((space: any) => space.tabs.some((tab: any) => tab.terminals.some((pane: any) => pane.terminal === parent)));
      const tab = space?.tabs.find((tab: any) => tab.terminals.some((pane: any) => pane.terminal === parent));
      const pane = tab?.terminals.find((pane: any) => pane.terminal === parent);
      // status.agent can fall back to an invisible agent; require the actual selected pane.
      const selected = space?.active && tab?.active && status.space === space.id && status.tab === tab.id && status.focused_pane === pane?.pane;
      stable = selected ? stable + 1 : 0;
      return stable >= 2;
    }, "The native parent pane did not become visible.");
    execFileSync(binary, ["shot", join(evidence, name + ".png")], { timeout: 15_000 });
  };
  try {
    parent = createSubagentPane("app-native-" + outcome);
    await waitForShellReady(parent);
    runScriptInPane(parent, `cd ${shellQuote(repo)} && PI_CODING_AGENT_DIR=${shellQuote(agent)} PI_HERDR_APP_CLI=${shellQuote(process.env.PI_INTEGRATION_APP_BIN!)} ${shellQuote(process.execPath)} ${shellQuote(entry)} -ne -e ${shellQuote(wrapper)} --session ${shellQuote(parentFile)} --model pi-integration/test ${shellQuote(outcome === "shared" ? "APP_NATIVE_READY" : "APP_NATIVE_PARENT_START")}`, { scriptPath: join(root, "start-parent.sh") });
    if (outcome === "shared") {
      await until(() => rows(parentFile).some(row => content(row.message?.content).includes("APP_NATIVE_READY_ACK")), "The shared parent did not initialize.");
      runInPane(parent, "/replica-directory shared");
      await until(() => existsSync(join(repo, ".pi", "replicate.json")), "The shared-directory command did not persist its setting.");
      assert.equal(JSON.parse(readFileSync(join(repo, ".pi", "replicate.json"), "utf8")).directoryMode, "shared");
      runInPane(parent, "APP_NATIVE_PARENT_START");
    }
    await until(() => rows(parentFile).some(row => row.message?.role === "toolResult" && row.message.toolName === "replicate"), "The native parent did not receive a replicate receipt.");
    const launch = rows(parentFile).find(row => row.message?.role === "toolResult" && row.message.toolName === "replicate").message;
    assert.notEqual(launch.isError, true, content(launch.content));
    assert.ok(launch.details.id);
    await until(() => rows(witness).some(row => row.child === launch.details.id), "The native child runtime did not initialize.");
    const child = rows(witness).find(row => row.child === launch.details.id);
    if (outcome === "shared") assert.equal(child.cwd, repo);
    else assert.notEqual(child.cwd, repo);
    assert.equal(readlinkSync(`/proc/${child.pid}/cwd`), child.cwd);
    assert.equal(resolve(child.argv[1]), resolve(entry));
    await until(() => getProviderRequests().some(request => request.userText.includes("APP_NATIVE_CHILD_TASK") && request.text.includes("APP_UNTRACKED_CONTEXT")), "The native child did not read the snapshot.");
    assert.equal(readFileSync(join(child.cwd, "tracked.txt"), "utf8"), "APP_DIRTY_TRACKED\n");
    assert.equal(readFileSync(join(child.cwd, "context.txt"), "utf8"), "APP_UNTRACKED_CONTEXT\n");
    const parentRequest = getProviderRequests().find(request => request.userText === "APP_NATIVE_PARENT_START")!;
    const childRequest = getProviderRequests().find(request => request.userText.includes("APP_NATIVE_CHILD_TASK"))!;
    assert.deepEqual(childRequest.tools, parentRequest.tools);
    assert.deepEqual(Object.keys(childRequest.toolParameters.replicate.properties!).sort(), ["name", "task"]);
    assert.deepEqual(childRequest.messages.filter(message => message.role === "system"), parentRequest.messages.filter(message => message.role === "system"));
    assert.ok(childRequest.text.includes("APP_NATIVE_PARENT_START"));
    await until(() => rows(parentFile).some(row => content(row.message?.content).includes("APP_NATIVE_PARENT_ACK")), "The parent did not settle after launch.");
    runInPane(parent, "APP_NATIVE_PARENT_INDEPENDENT");
    await until(() => rows(parentFile).some(row => content(row.message?.content).includes("APP_NATIVE_INDEPENDENT_DONE")), "The parent was blocked by child work.");
    assert.equal(rows(parentFile).filter(row => row.customType === "subagent_result").length, 0);
    await capture("parent-while-child-active");
    if (outcome === "conflict") writeFileSync(join(repo, "app-result.txt"), "APP_PARENT_CONFLICT\n");
    if (outcome === "failed") {
      await until(() => existsSync(join(child.cwd, "app-result.txt")), "The failed child did not save its partial work.");
      assert.equal(readlinkSync(`/proc/${child.pid}/cwd`), child.cwd);
      assert.equal(rows(witness).find(row => row.child === launch.details.id).pid, child.pid);
      childKilled = true;
      process.kill(child.pid, "SIGKILL");
    }
    writeFileSync(release, "release");
    await until(() => rows(parentFile).some(row => row.customType === "subagent_result"), "The native child did not deliver its result.");
    const result = rows(parentFile).find(row => row.customType === "subagent_result");
    assert.equal(result.details.childId, launch.details.id);
    assert.equal(result.details.parentToolCallId, launch.toolCallId);
    assert.equal(result.details.originatingToolCallId, launch.toolCallId);
    assert.equal(result.details.receiverSessionId, rows(parentFile)[0].id);
    // Delivery points at the durable checkpoint, not the retired live pathname.
    assert.equal(rows(result.details.sessionFile)[0].id, child.id);
    assert.equal(rows(child.file)[0].id, child.id);
    const success = outcome !== "failed" && outcome !== "empty";
    assert.equal(result.details.exitCode === 0, success);
    assert.equal(result.details.integration.status, success ? outcome : "not-attempted");
    if (success) {
      assert.ok(rows(result.details.sessionFile).some(row => content(row.message?.content).includes("APP_NATIVE_CHILD_SUMMARY")));
      assert.ok(result.content.includes("APP_NATIVE_CHILD_SUMMARY"));
    }
    if (outcome === "conflict") assert.equal(readFileSync(join(repo, "app-result.txt"), "utf8"), "APP_PARENT_CONFLICT\n");
    else if (outcome === "failed" || outcome === "empty") assert.equal(existsSync(join(repo, "app-result.txt")), false);
    else assert.equal(readFileSync(join(repo, "app-result.txt"), "utf8"), "APP_NATIVE_JOINED\n");
    await until(() => {
      const inventory = appCore(["ls", "--all"]);
      return !existsSync(`/proc/${child.pid}`) && (outcome !== "applied" || !existsSync(child.cwd)) && !(Array.isArray(inventory) ? inventory : inventory.terminals).some((terminal: { address: string }) => terminal.address === child.pane);
    }, "The child process or its native core terminal survived cleanup.", 15_000);
    assert.equal(existsSync(child.cwd), outcome !== "applied");
    if (outcome !== "applied") assert.equal(readFileSync(join(child.cwd, "app-result.txt"), "utf8"), "APP_NATIVE_JOINED\n");
    if (outcome === "shared") {
      assert.equal(readFileSync(join(repo, "ignored.txt"), "utf8"), "APP_IGNORED_CONTEXT\n");
      assert.ok(getProviderRequests().some(request => request.userText.includes("APP_NATIVE_CHILD_TASK") && request.text.includes("APP_IGNORED_CONTEXT")));
      assert.equal(git("branch", "--list"), branches);
      assert.equal(git("worktree", "list", "--porcelain"), trees);
    }
    assert.equal(git("rev-parse", "HEAD"), head);
    assert.deepEqual(readFileSync(join(repo, ".git", "index")), index);
    await until(() => rows(parentFile).some(row => content(row.message?.content).includes("APP_NATIVE_PARENT_COMPLETE")), "The native parent did not continue after delivery.");
    await capture("parent-after-result");
    const starts = rows(witness).filter(row => !row.child).length;
    runInPane(parent, "/reload");
    await until(() => rows(witness).filter(row => !row.child).length > starts, "The native parent did not reload.");
    await delay(800);
    assert.equal(rows(parentFile).filter(row => row.customType === "subagent_result").length, 1);
  } catch (error) {
    if (evidence) { mkdirSync(evidence, { recursive: true }); writeFileSync(join(evidence, "failure.txt"), error instanceof Error ? error.stack ?? error.message : String(error)); }
    throw error;
  } finally {
    writeFileSync(release, "release");
    setProviderResponsePlan(undefined);
    if (evidence) {
      mkdirSync(evidence, { recursive: true });
      for (const file of [parentFile, witness, ...rows(witness).filter(row => row.child).map(row => row.file)]) if (existsSync(file)) {
        writeFileSync(join(evidence, file === parentFile ? "parent.jsonl" : file === witness ? "starts.jsonl" : "child.jsonl"), readFileSync(file));
      }
      writeFileSync(join(evidence, "provider.json"), JSON.stringify(getProviderRequests()));
      // Worktree removal runs concurrently. Copy stable evidence, not directories
      // which may disappear while Node's recursive copier is traversing them.
      cpSync(agent, join(evidence, "agent"), { recursive: true, filter: path => path !== join(agent, "replica-worktrees") });
      for (const name of ["HEAD", "index", "config"]) writeFileSync(join(evidence, "source-" + name), readFileSync(join(repo, ".git", name)));
      const observe = (read: () => unknown) => { try { return read(); } catch (error) { return { error: String(error) }; } };
      const mirror = await import("../../pi-extension/subagents/herdr.js");
      const binding = await import("../../pi-extension/subagents/session-binding.js");
      const childRuntime = rows(witness).find(runtime => runtime.child);
      if (childRuntime && outcome !== "shared") {
        const work = JSON.parse(readFileSync(join(agent, "subagent-sessions", "replicas", childRuntime.child + ".json"), "utf8"));
        writeFileSync(join(evidence, "cleanup-guards.json"), JSON.stringify({
          worktrees: observe(() => mirror.listHerdrWorktrees(repo)),
          panes: observe(() => JSON.parse(mirror.herdrExec(["pane", "list", "--workspace", work.worktree.workspaceId]))),
          ownerAlive: observe(() => binding.sessionLocationAlive(work.worktreeLocation)),
          ownsPane: observe(() => binding.sessionOwnsPane(work.worktreeLocation, work.worktree.paneId, mirror.getHerdrPaneProcessInfo(work.worktree.paneId).shellPid)),
        }));
      }
      writeFileSync(join(evidence, "observations.json"), JSON.stringify(rows(witness).map(runtime => ({
        runtime, alive: existsSync(`/proc/${runtime.pid}`),
        core: observe(() => appCore(["get", runtime.pane])),
        processInfo: observe(() => mirror.getHerdrPaneProcessInfo(runtime.pane)),
      }))));
      if (parent) {
        try { writeFileSync(join(evidence, "parent-screen.txt"), appCore(["read", parent, "--lines", "100"], true)); await capture("parent-final"); }
        catch (error) { writeFileSync(join(evidence, "capture-error.txt"), String(error)); }
      }
    }
    if (parent) {
      const pid = rows(witness).find(runtime => !runtime.child)?.pid;
      closePane(parent);
      if (pid) await until(() => !existsSync(`/proc/${pid}`), "The fixture parent survived terminal cleanup.", 15_000);
    }
  }
});
