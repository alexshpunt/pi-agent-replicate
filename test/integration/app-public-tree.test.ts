import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { appCore } from "../../pi-extension/subagents/herdr-app.ts";
import { closePane, createSubagentPane, getPaneProcessInfo, runInPane, runScriptInPane, shellQuote, waitForShellReady } from "../../pi-extension/subagents/terminal.ts";
import { getProviderRequests, resetProviderRequests, setProviderResponsePlan, TEST_PROVIDER_URL } from "./fake-provider.ts";

async function until(check: () => boolean, label: string): Promise<void> {
  const end = Date.now() + 60_000;
  while (Date.now() < end) { if (check()) return; await new Promise(resolve => setTimeout(resolve, 50)); }
  assert.fail(label);
}
function entries(file: string): any[] {
  return existsSync(file) ? readFileSync(file, "utf8").split("\n").filter(Boolean).map(line => JSON.parse(line)) : [];
}
function text(value: unknown): string {
  return typeof value === "string" ? value : Array.isArray(value) ? value.map(part => part.text ?? "").join("\n") : "";
}

for (const outcome of ["clean", "error"] as const) test(`native public tree retains the ${outcome} child's managed worktree`, { timeout: 150_000 }, async () => {
  const root = join(process.env.PI_INTEGRATION_HERDR_RUN_DIR!, "public-tree-" + outcome), repo = join(root, "repo"), agent = join(root, "agent");
  mkdirSync(repo, { recursive: true }); mkdirSync(agent);
  const git = (...args: string[]) => execFileSync("git", args, { cwd: repo, encoding: "utf8" }).trim();
  git("init", "-b", "main"); git("config", "user.name", "Integration"); git("config", "user.email", "integration@example.invalid");
  writeFileSync(join(repo, "base.txt"), "APP_ROOT_BASE\n"); git("add", "."); git("commit", "-m", "Create API base");
  const base = git("rev-parse", "HEAD");
  writeFileSync(join(repo, "base.txt"), "APP_ROOT_MAIN\n"); git("commit", "-am", "Advance API main");
  const head = git("rev-parse", "HEAD"), index = readFileSync(join(repo, ".git", "index"));
  const parentFile = join(root, "parent.jsonl"), handleFile = join(root, "handle.json"), resultFile = join(root, "child-result.json"), finalFile = join(root, "tree-result.json"), failureFile = join(root, "command-error.json"), release = join(root, "release");
  writeFileSync(join(agent, "settings.json"), JSON.stringify({ defaultProjectTrust: "always" }));
  writeFileSync(join(agent, "models.json"), JSON.stringify({ providers: { "pi-integration": {
    baseUrl: TEST_PROVIDER_URL, api: "openai-completions", apiKey: "test",
    compat: { supportsDeveloperRole: false, supportsReasoningEffort: false, supportsUsageInStreaming: false },
    models: [{ id: "test", name: "Deterministic fixture", reasoning: false, input: ["text"], contextWindow: 128000, maxTokens: 4096, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }],
  } } }));
  const packed = JSON.parse(execFileSync("npm", ["pack", "--json", "--pack-destination", root], { cwd: fileURLToPath(new URL("../..", import.meta.url)), encoding: "utf8" }))[0];
  writeFileSync(join(root, "package.json"), JSON.stringify({ name: "native-app-consumer", private: true, type: "module", dependencies: { "pi-agent-replicate": "file:" + join(root, packed.filename) } }));
  execFileSync("npm", ["install", "--ignore-scripts", "--legacy-peer-deps", "--no-audit", "--no-fund"], { cwd: root, encoding: "utf8" });
  const wrapper = join(root, "consumer.ts"), api = join(root, "node_modules", "pi-agent-replicate", "index.js");
  writeFileSync(wrapper, `import {createSubagentTree} from ${JSON.stringify(api)};import {writeFileSync} from 'node:fs';
export default function(pi){pi.registerCommand('native-tree',{async handler(_args,ctx){try{const tree=createSubagentTree({pi,ctx,metadata:{fixture:'APP_ROOT_METADATA'}});tree.bindFinalCallback(result=>writeFileSync(${JSON.stringify(finalFile)},JSON.stringify(result)));const child=await tree.launchChild({parentId:tree.callerId,name:'native-api-child',task:'APP_ROOT_CHILD. Read base.txt and save retained.txt.',tools:['read','write'],metadata:{fixture:'APP_ROOT_METADATA'},worktree:{branch:'native-root-branch',base:${JSON.stringify(base)}}});writeFileSync(${JSON.stringify(handleFile)},JSON.stringify({nodeId:child.nodeId,parentId:child.parentId,callerId:tree.callerId,treeId:tree.treeId}));writeFileSync(${JSON.stringify(resultFile)},JSON.stringify(await child.result));}catch(error){writeFileSync(${JSON.stringify(failureFile)},JSON.stringify({error:String(error),stack:error.stack}));throw error;}}});}
`);
  resetProviderRequests();
  setProviderResponsePlan(async request => {
    const messages: any[] = request.messages ?? [], user = text([...messages].reverse().find(message => message.role === "user")?.content);
    const calls = messages.flatMap(message => message.tool_calls ?? []).map(call => call.function?.name);
    if (user.includes("APP_ROOT_CHILD")) {
      if (!calls.includes("read")) return { toolCalls: [{ name: "read", arguments: { path: "base.txt" } }] };
      if (!calls.includes("write")) return { toolCalls: [{ name: "write", arguments: { path: "retained.txt", content: "APP_ROOT_RETAINED\n" } }] };
      await until(() => existsSync(release), "The API child gate was not released.");
      return { text: "APP_ROOT_CHILD_ANSWER" };
    }
    if (user === "APP_ROOT_READY") return { text: "APP_ROOT_READY_ACK" };
    if (user === "APP_ROOT_FINISH") return { text: "APP_ROOT_PARENT_ANSWER" };
    throw new Error("Unexpected API fixture request: " + user);
  });
  let parent: string | undefined, childPane: string | undefined;
  try {
    parent = createSubagentPane("native-public-" + outcome); await waitForShellReady(parent);
    runScriptInPane(parent, `cd ${shellQuote(repo)} && PI_CODING_AGENT_DIR=${shellQuote(agent)} PI_HERDR_APP_CLI=${shellQuote(process.env.PI_INTEGRATION_APP_BIN!)} ${shellQuote(process.execPath)} ${shellQuote(process.env.PI_INTEGRATION_PI_ENTRY!)} -ne -e ${shellQuote(wrapper)} --session ${shellQuote(parentFile)} --model pi-integration/test APP_ROOT_READY`, { scriptPath: join(root, "parent.sh") });
    await until(() => entries(parentFile).some(row => text(row.message?.content).includes("APP_ROOT_READY_ACK")), "The API parent did not initialize.");
    runInPane(parent, "/native-tree");
    await until(() => existsSync(handleFile) || existsSync(failureFile), "The public API did not return a child handle.");
    assert.equal(existsSync(failureFile), false, existsSync(failureFile) ? readFileSync(failureFile, "utf8") : "The native public launch failed.");
    const handle = JSON.parse(readFileSync(handleFile, "utf8"));
    assert.equal(handle.parentId, handle.callerId);
    await until(() => getProviderRequests().some(request => request.userText.includes("APP_ROOT_CHILD") && request.text.includes("APP_ROOT_BASE")) || existsSync(resultFile), "The API child did not read its requested checkout.");
    assert.equal(existsSync(resultFile), false, existsSync(resultFile) ? readFileSync(resultFile, "utf8") : "The API child settled before its gate.");
    const request = getProviderRequests().find(request => request.userText.includes("APP_ROOT_CHILD"))!;
    assert.deepEqual([...request.tools].sort(), ["read", "write"]);
    const record = git("worktree", "list", "--porcelain").split("\n\n").find(record => record.includes("branch refs/heads/native-root-branch"))!;
    const path = record.split("\n").find(line => line.startsWith("worktree "))!.slice(9);
    const world = JSON.parse(execFileSync(process.env.PI_INTEGRATION_APP_BIN!, ["ls"], { encoding: "utf8" }));
    const space = world.spaces.find((space: any) => space.folder === path);
    assert.ok(space);
    childPane = space.tabs[0].terminals[0].terminal;
    const info = getPaneProcessInfo(childPane!);
    const child = info.foregroundProcesses.find(observed => observed.cwd === path && readlinkSync(`/proc/${observed.pid}/exe`) === process.execPath)!;
    assert.ok(child);
    assert.equal(readlinkSync(`/proc/${child.pid}/cwd`), path);
    assert.equal(execFileSync("git", ["rev-parse", "HEAD"], { cwd: path, encoding: "utf8" }).trim(), base);
    await until(() => existsSync(join(path, "retained.txt")), "The API child did not save its partial work.");
    assert.equal(readFileSync(join(path, "retained.txt"), "utf8"), "APP_ROOT_RETAINED\n");
    if (outcome === "error") process.kill(child.pid, "SIGKILL");
    writeFileSync(release, "release");
    await until(() => existsSync(resultFile), "The public child promise did not settle.");
    const result = JSON.parse(readFileSync(resultFile, "utf8"));
    assert.equal(result.outcome, outcome);
    if (outcome === "clean") assert.equal(result.answer, "APP_ROOT_CHILD_ANSWER");
    else assert.ok(result.error?.code);
    assert.equal(result.worktree.path, path);
    assert.equal(result.worktree.branch, "native-root-branch");
    assert.equal(result.worktree.baseSha, base);
    assert.equal(result.worktree.headSha, base);
    assert.equal(result.worktree.clean, false);
    assert.equal(result.worktree.conflicted, false);
    assert.ok(result.worktree.untrackedFiles.includes("retained.txt"));
    assert.equal(result.worktree.paneId, childPane);
    assert.equal(result.metadata.nodeId, handle.nodeId);
    assert.equal(result.metadata.treeId, handle.treeId);
    assert.deepEqual(result.metadata.value, { fixture: "APP_ROOT_METADATA" });
    await until(() => !existsSync(`/proc/${child.pid}`), "The public child Pi did not exit.");
    assert.equal(appCore(["get", childPane!]).state, "live");
    assert.equal(readFileSync(join(path, "retained.txt"), "utf8"), "APP_ROOT_RETAINED\n");
    assert.equal(git("rev-parse", "HEAD"), head);
    assert.deepEqual(readFileSync(join(repo, ".git", "index")), index);
    assert.equal(existsSync(join(repo, "retained.txt")), false);
    runInPane(parent, "APP_ROOT_FINISH");
    await until(() => existsSync(finalFile), "The public tree callback did not settle.");
    const final = JSON.parse(readFileSync(finalFile, "utf8"));
    // The first launched child is the tree root; the hosting Pi is its caller.
    assert.equal(final.state, outcome === "clean" ? "completed" : "failed");
    assert.equal(final.rootResult.resultId, result.resultId);
    assert.deepEqual(final.callerMetadata.value, { fixture: "APP_ROOT_METADATA" });
    assert.equal(final.nodes.length, 1);
    assert.equal(final.nodes[0].nodeId, handle.nodeId);
    assert.equal(final.nodes[0].outcome, outcome);
  } finally {
    writeFileSync(release, "release");
    if (childPane) closePane(childPane);
    if (parent) closePane(parent);
    setProviderResponsePlan(undefined);
    const evidence = process.env.PI_INTEGRATION_APP_EVIDENCE;
    if (evidence) {
      const target = join(evidence, "public-tree-" + outcome); mkdirSync(target, { recursive: true });
      for (const file of [parentFile, handleFile, resultFile, finalFile, failureFile]) if (existsSync(file)) writeFileSync(join(target, file.split("/").at(-1)!), readFileSync(file));
      writeFileSync(join(target, "provider.json"), JSON.stringify(getProviderRequests()));
    }
  }
});
