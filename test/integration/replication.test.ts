import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { getProviderRequests, resetProviderRequests } from "./fake-provider.ts";
import { cleanupTestEnv, closePane, createTestEnv, createTrackedSurface, getAvailableBackends, runInPane, readPaneAsync, shellQuote, sleep, startPi, waitForPaneAbsence, waitForPaneReady, waitForScreen, PI_TIMEOUT, type TestEnv } from "./harness.ts";
import { childSessionLocation, readSessionBinding, sessionLocationAlive } from "../../pi-extension/subagents/session-binding.ts";
import { readReplicaWork } from "../../pi-extension/subagents/replica-work.ts";

const packageTools = new Set(["replicate", "subagent", "subagent_resume", "subagent_interrupt", "subagent_cancel", "subagents_list", "caller_ping", "subagent_done"]);
function entries(path: string): any[] {
	if (!existsSync(path)) return [];
	const source = readFileSync(path, "utf8");
	const complete = source.slice(0, source.lastIndexOf("\n") + 1).trim();
	return complete ? complete.split("\n").map((line) => JSON.parse(line)) : [];
}
async function waitUntil(check: () => boolean, explanation: string): Promise<void> {
	const deadline = Date.now() + PI_TIMEOUT;
	while (Date.now() < deadline) {
		if (check()) return;
		await sleep(50);
	}
	assert.fail(explanation);
}
async function assertReplicaSurfaceClosed(result: any): Promise<void> {
	const binding = readSessionBinding(result.details.sessionFile)!;
	const location = childSessionLocation(binding.child!.lineage.rootDir, binding.child!.lineage.nodeId)!;
	assert.equal(await waitForPaneAbsence(location.paneId!, { timeoutMs: 10_000 }), true, "a settled replica must not leave its pane open");
	const work = readReplicaWork(binding.child!.environment.PI_SUBAGENT_REPLICA_WORK_FILE);
	const workspaces = JSON.parse(execFileSync("herdr", ["workspace", "list"], { encoding: "utf8" })).result.workspaces;
	assert.equal(workspaces.some((workspace: any) => workspace.workspace_id === work.worktree!.workspaceId), false, "the empty replica workspace must leave the sidebar");
}
function systemText(request: ReturnType<typeof getProviderRequests>[number]): string {
	return JSON.stringify(request.messages.filter((message) => message.role === "system"));
}

for (const backend of getAvailableBackends()) {
	describe(`replication (${backend})`, { timeout: process.env.PI_INTEGRATION_TUI_DIR ? 660_000 : PI_TIMEOUT * 3 }, () => {
		let env: TestEnv;
		beforeEach(() => { resetProviderRequests(); env = createTestEnv(backend, { replication: true }); });
		afterEach(async () => {
			const artifacts = process.env.PI_INTEGRATION_DEBUG_ARTIFACT_DIR;
			if (artifacts) {
				mkdirSync(artifacts, { recursive: true });
				const parents = readdirSync(env.dir).filter(file => file.endsWith(".jsonl")).map(file => ({ file, entries: entries(join(env.dir, file)) }));
				const launched = parents.flatMap(parent => parent.entries).filter(row => row.message?.toolName === "replicate").map(row => row.message.details).filter(details => details?.sessionFile);
				const read = (file: string) => { try { return readFileSync(file, "utf8"); } catch { return null; } };
				const children = await Promise.all(launched.map(async launch => {
					const binding = readSessionBinding(launch.sessionFile);
					const location = binding?.child && childSessionLocation(binding.child.lineage.rootDir, binding.child.lineage.nodeId);
					return { launch, entries: entries(launch.sessionFile), location, exit: read(launch.sessionFile + ".exit"), stop: read(launch.sessionFile + ".replica-stop"), work: read(join(env.dir, ".pi", "agent", "subagent-sessions", "replicas", launch.id + ".json")), screen: location?.paneId ? await readPaneAsync(location.paneId, 80).catch(String) : null };
				}));
				writeFileSync(join(artifacts, env.dir.split("/").at(-1)! + ".json"), JSON.stringify({ parents, children, screens: await Promise.all(env.surfaces.map(surface => readPaneAsync(surface, 80).catch(String))) }));
			}
			await cleanupTestEnv(env);
		});

		for (const [stage, command, pattern] of [["checkpoint", "git", "*"], ["join", "git", "*merge-tree*"], ["cleanup", "herdr", "*worktree*remove*"]]) {
			it(`keeps the parent responsive while replica ${stage} is held`, async () => {
				const inspection = stage === "checkpoint" ? process.env.PI_INTEGRATION_TUI_DIR : undefined;
				const ide = inspection ? process.env.PI_INTEGRATION_IDE_ENTRY : undefined;
				if (inspection) { assert.ok(ide && existsSync(ide), "native visual proof requires the current IDE"); mkdirSync(inspection, { recursive: true }); }
				const parentFile = join(env.dir, "responsive-original.jsonl");
				const state = join(env.dir, ".pi", "agent", "completion-delay");
				mkdirSync(state);
				const bin = join(state, "bin"); mkdirSync(bin);
				const armed = join(state, "armed"), started = join(state, "started"), release = join(state, "release"), pulse = join(state, "pulse");
				for (const executableName of stage === "cleanup" ? ["git", "herdr"] : [command]) {
					const executable = execFileSync("which", [executableName], { encoding: "utf8" }).trim();
					writeFileSync(join(bin, executableName), `#!/bin/bash\nif [[ "$*" == ${pattern} ]] && test -f ${shellQuote(armed)} && test ! -f ${shellQuote(started)}; then\n touch ${shellQuote(started)}\n for ((i=0;i<${inspection ? 6000 : 200};i++)); do test -f ${shellQuote(release)} && break; sleep 0.05; done\nfi\nexec ${shellQuote(executable)} "$@"\n`, { mode: 0o700 });
				}
				const capability = join(env.dir, "completion-delay-capability.ts");
				writeFileSync(capability, `import {Type} from ${JSON.stringify(new URL("../../node_modules/@sinclair/typebox/build/esm/index.mjs", import.meta.url).pathname)}; import {existsSync,readFileSync,writeFileSync} from 'node:fs'; import {join} from 'node:path'; export default function(pi){let timer;pi.on('session_start',()=>{if(!process.env.PI_SUBAGENT_ID){const witness=${JSON.stringify(join(state, 'runtime.json'))};const starts=existsSync(witness)?JSON.parse(readFileSync(witness,'utf8')).starts:0;writeFileSync(witness,JSON.stringify({starts:starts+1,readHasViews:!!pi.getAllTools().find(t=>t.name==='read')?.parameters?.properties?.views,ideSource:process.env.PI_INTEGRATION_IDE_SOURCE_COMMIT,argv:process.argv}));process.env.PATH=${JSON.stringify(bin)}+':'+process.env.PATH;timer=setInterval(()=>writeFileSync(${JSON.stringify(pulse)},String(Date.now())),25);}});pi.on('session_shutdown',()=>clearInterval(timer));pi.registerTool({name:'replication_probe',label:'Probe',description:'Save isolated source',parameters:Type.Object({}),async execute(){writeFileSync(join(process.cwd(),'responsive-change.txt'),'CHILD_EDIT');writeFileSync(${JSON.stringify(armed)},'ready');return {content:[{type:'text',text:'CAPABILITY_INHERITED'}],details:{}}}});}\n`);
				const parent = createTrackedSurface(env, "responsive-original");
				await waitForPaneReady(parent);
				startPi(parent, env.dir, "Return exactly RESPONSIVE_READY", { environment: stage === "checkpoint" ? { PI_SUBAGENT_QUIET_THRESHOLD_MS: inspection ? "20000" : "2000" } : undefined, extraArgs: `--session ${shellQuote(parentFile)} ${ide ? `-e ${shellQuote(ide)}` : ""} -e ${shellQuote(capability)}` });
				await waitUntil(() => entries(parentFile).some((row) => row.message?.role === "assistant"), "parent ready");
				if (inspection) {
					runInPane(parent, "/reload");
					await waitUntil(() => JSON.parse(readFileSync(join(state, "runtime.json"), "utf8")).starts >= 2, "native reload must complete");
					assert.ok(JSON.parse(readFileSync(join(state, "runtime.json"), "utf8")).argv.includes(ide));
					writeFileSync(join(inspection, "runtime.json"), JSON.stringify({ ...JSON.parse(readFileSync(join(state, "runtime.json"), "utf8")), readHasViews: !!getProviderRequests().find(request => request.toolParameters.read?.properties?.views) }));
				}
				runInPane(parent, 'Call the replicate tool once with task: "Use replication_probe then Return exactly REPLICATION_SUMMARY"');
				try {
					try { await waitUntil(() => existsSync(started), "completion must reach the held operation"); }
					catch (error) {
						const result = entries(parentFile).find((row) => row.customType === "subagent_result");
						const binding = result && readSessionBinding(result.details.sessionFile);
						const file = binding?.child?.environment.PI_SUBAGENT_REPLICA_WORK_FILE;
						const work = file && existsSync(file) ? readReplicaWork(file) : undefined;
						assert.fail(`${error}\n${JSON.stringify({ stage, result: result?.content, work: work && { cleaned: work.cleaned, integration: work.integration, worktree: work.worktree, location: work.worktreeLocation } })}`);
					}
					const before = Number(readFileSync(pulse, "utf8"));
					await sleep(400);
					console.log(JSON.stringify({ completionStage: stage, heldObservationMs: 400, parentHeartbeatAdvanceMs: Number(readFileSync(pulse, "utf8")) - before }));
					assert.ok(Number(readFileSync(pulse, "utf8")) > before, "parent event loop must advance before Git is released");
					if (stage === "checkpoint") await sleep(2500); // Cross the quiet threshold while the model is already finished.
					runInPane(parent, "Return exactly PARENT_WORK_DURING_COMPLETION");
					await waitUntil(() => entries(parentFile).some((row) => row.message?.role === "assistant" && JSON.stringify(row.message.content).includes("PARENT_WORK_DURING_COMPLETION")), "parent must finish independent work while Git is held");
					assert.equal(existsSync(release), false);
					if (inspection) assert.ok(getProviderRequests().some(request => !!request.toolParameters.read?.properties?.views), "the real model request must use the IDE reader schema");
					// Reattach the original while its completion worker still owns the checkpoint gate.
					if (stage === "checkpoint") {
						const starts = JSON.parse(readFileSync(join(state, "runtime.json"), "utf8")).starts;
						runInPane(parent, "/reload");
						await waitUntil(() => JSON.parse(readFileSync(join(state, "runtime.json"), "utf8")).starts > starts, "reload during held completion must remain responsive");
					}
					if (inspection) {
						writeFileSync(join(inspection, "pane.json"), JSON.stringify({stage:"held",pane:parent,config:process.env.HERDR_CONFIG_PATH,socket:process.env.HERDR_SOCKET_PATH}));
						writeFileSync(join(inspection, "runtime.json"), JSON.stringify({ ...JSON.parse(readFileSync(join(state, "runtime.json"), "utf8")), readHasViews: true }));
						const deadline=Date.now()+300000;
						while(!existsSync(join(inspection,"release-child"))) {assert.ok(Date.now()<deadline,"observer must release held completion");await sleep(100);}
					}
				} finally { writeFileSync(release, "release"); }
				await waitUntil(() => entries(parentFile).some((row) => row.customType === "subagent_result"), "completion must deliver after release");
				const results = entries(parentFile).filter((row) => row.customType === "subagent_result");
				assert.equal(results.length, 1);
				assert.equal(results[0].details.integration.status, "applied");
				assert.equal(readFileSync(join(env.dir, "responsive-change.txt"), "utf8"), "CHILD_EDIT");
				if (inspection) {
					writeFileSync(join(inspection,"result.json"),JSON.stringify(results[0]));
					writeFileSync(join(inspection,"pane.json"),JSON.stringify({stage:"delivered",pane:parent,config:process.env.HERDR_CONFIG_PATH,socket:process.env.HERDR_SOCKET_PATH}));
					const deadline=Date.now()+300000;
					while(!existsSync(join(inspection,"finish"))) {assert.ok(Date.now()<deadline,"observer must finish");await sleep(100);}
				}
			});
		}

		for (const task of ["REPLICATION_FAIL_WITH_HISTORY", "Return exactly EMPTY_COMPLETION"]) {
			it(`reports ${task} as failure and retains its work`, async () => {
				const parentFile = join(env.dir, "failure-original.jsonl");
				const parent = createTrackedSurface(env, "failure-original");
				await waitForPaneReady(parent);
				startPi(parent, env.dir, "Return exactly INHERITED_ANSWER_NOT_HISTORY", { extraArgs: `--session ${shellQuote(parentFile)}` });
				await waitUntil(() => entries(parentFile).some((entry) => entry.message?.role === "assistant" && JSON.stringify(entry.message.content).includes("INHERITED_ANSWER_NOT_HISTORY")), "the inherited answer must be saved before cloning");
				runInPane(parent, `Call the replicate tool once with task: ${JSON.stringify(task)}`);
				await waitUntil(() => entries(parentFile).some((entry) => entry.customType === "subagent_result"), "failure must wake the original");
				const results = entries(parentFile).filter((entry) => entry.customType === "subagent_result");
				assert.equal(results.length, 1);
				const result = results[0];
				assert.match(result.content, /Replica .* error/);
				assert.match(result.content, task === "REPLICATION_FAIL_WITH_HISTORY" ? /deterministic replica terminal failure/ : /no required summary/);
				const history = readFileSync(result.details.historyPath, "utf8");
				assert.doesNotMatch(history, /INHERITED_ANSWER_NOT_HISTORY|TOOL_OUTPUT_NOT_AN_ANSWER|echo TOOL_OUTPUT|Call the replicate tool/);
				if (task === "REPLICATION_FAIL_WITH_HISTORY") assert.match(history, /REPLICA_FIRST_ANSWER/);
				else assert.match(history, /No textual answers were produced/);
				const binding = readSessionBinding(result.details.sessionFile)!;
				const location = childSessionLocation(binding.child!.lineage.rootDir, binding.child!.lineage.nodeId)!;
				await waitUntil(() => !sessionLocationAlive(location), "the failed model process must exit");
				assert.equal(existsSync(entries(result.details.sessionFile)[0].cwd), true);
				await assertReplicaSurfaceClosed(result);
				assert.equal(existsSync(result.details.worktreePath), true, "closing the failed pane must retain its source");
				assert.equal(result.details.integration.status, "not-attempted");
			});
		}
		it("reports unexpected replica process loss without restarting and retains partial work", async () => {
			const parentFile = join(env.dir, "crash-original.jsonl"), capability = join(env.dir, "crash-capability.ts"), crashes = join(env.dir, "child-crashes.txt");
			writeFileSync(capability, `import {appendFileSync,writeFileSync} from 'node:fs'; import {join} from 'node:path'; export default function(pi){pi.on('before_agent_start',()=>{if(process.cwd()!==${JSON.stringify(env.dir)}){writeFileSync(join(process.cwd(),'crash-partial.txt'),'CRASH_PARTIAL');appendFileSync(${JSON.stringify(crashes)},process.pid+'\\n');process.kill(process.pid,'SIGKILL');}});}\n`);
			const parent = createTrackedSurface(env, "crash-original");
			await waitForPaneReady(parent);
			startPi(parent, env.dir, "Return exactly CRASH_READY", { extraArgs: `--session ${shellQuote(parentFile)} -e ${shellQuote(capability)}` });
			await waitUntil(() => entries(parentFile).some((row) => row.message?.role === "assistant"), "parent ready");
			const head = execFileSync("git", ["rev-parse", "HEAD"], { cwd: env.dir, encoding: "utf8" });
			const index = execFileSync("git", ["ls-files", "--stage"], { cwd: env.dir, encoding: "utf8" });
			runInPane(parent, 'Call the replicate tool once with task: "Return exactly UNREACHABLE_CRASH_SUMMARY"');
			await waitUntil(() => entries(parentFile).some((row) => row.customType === "subagent_result"), "process loss must deliver an honest terminal result");
			const results = entries(parentFile).filter((row) => row.customType === "subagent_result");
			assert.equal(results.length, 1);
			const result = results[0];
			assert.match(result.content, /Replica .* error/);
			assert.equal(result.details.integration.status, "not-attempted");
			assert.equal(readFileSync(join(result.details.worktreePath, "crash-partial.txt"), "utf8"), "CRASH_PARTIAL");
			assert.ok(existsSync(result.details.sessionFile) && existsSync(result.details.historyPath));
			assert.equal(existsSync(join(env.dir, "crash-partial.txt")), false);
			assert.equal(execFileSync("git", ["rev-parse", "HEAD"], { cwd: env.dir, encoding: "utf8" }), head);
			assert.equal(execFileSync("git", ["ls-files", "--stage"], { cwd: env.dir, encoding: "utf8" }), index);
			assert.equal(new Set(readFileSync(crashes, "utf8").trim().split("\n")).size, 1, "the parent decides whether to restart its stopped copy");
		});
		for (const mode of ["resume", "fork"]) {
			it(`recovers failed outstanding changes with ${mode} and preserves the saved conversation`, async () => {
				const parentFile = join(env.dir, "recover-original.jsonl"), capability = join(env.dir, "recovery-capability.ts"), starts = join(env.dir, ".pi", "agent", "recovery-starts.json");
				writeFileSync(capability, `import {Type} from ${JSON.stringify(new URL("../../node_modules/@sinclair/typebox/build/esm/index.mjs", import.meta.url).pathname)}; import {existsSync,readFileSync,writeFileSync} from 'node:fs'; import {join} from 'node:path'; export default function(pi){pi.on('session_start',(_event,ctx)=>{const p=${JSON.stringify(starts)};const state=existsSync(p)?JSON.parse(readFileSync(p,'utf8')):{};const id=ctx.sessionManager.getSessionId();state[id]=(state[id]??0)+1;writeFileSync(p,JSON.stringify(state));});pi.on('agent_settled',(_event,ctx)=>{if(process.env.PI_SUBAGENT_REPLICATION!=='1')writeFileSync(${JSON.stringify(starts + '.idle')},JSON.stringify({id:ctx.sessionManager.getSessionId(),results:ctx.sessionManager.getEntries().filter(row=>row.customType==='subagent_result').length}));});pi.registerTool({name:'replication_probe',label:'Probe',description:'Write checkpoint content',parameters:Type.Object({}),async execute(){const p=join(process.cwd(),'outstanding.txt');writeFileSync(p,(existsSync(p)?readFileSync(p,'utf8'):'')+'step\\n');return {content:[{type:'text',text:'SAVED_CONVERSATION_FACT'}],details:{}}}});}\n`);
				const parent = createTrackedSurface(env, "recover-original");
				await waitForPaneReady(parent);
				startPi(parent, env.dir, "Return exactly RECOVERY_READY", { extraArgs: `--session ${shellQuote(parentFile)} -e ${shellQuote(capability)}` });
				await waitUntil(() => entries(parentFile).some((row) => row.message?.role === "assistant"), "parent ready");
				runInPane(parent, 'Call the replicate tool once with task: "Use replication_probe then Return exactly EMPTY_COMPLETION"');
				const results = () => entries(parentFile).filter((row) => row.customType === "subagent_result");
				await waitUntil(() => results().length === 1, "failed work must be returned");
				const failed = results()[0];
				assert.equal(failed.details.recoveryAvailable, true);
				assert.ok(failed.content.includes(failed.details.continuationId));
				if (mode === "resume") {
					const receiver = entries(parentFile)[0].id;
					await waitUntil(() => existsSync(starts + ".idle") && JSON.parse(readFileSync(starts + ".idle", "utf8")).id === receiver && JSON.parse(readFileSync(starts + ".idle", "utf8")).results === 1, "the receiver must settle its result turn before reload");
					const before = JSON.parse(readFileSync(starts, "utf8"))[receiver];
					runInPane(parent, "/reload");
					await waitUntil(() => JSON.parse(readFileSync(starts, "utf8"))[receiver] > before, "reload must reattach the receiving session");
					await waitForScreen(parent, /Reloaded keybindings, extensions/, 10_000);
					runInPane(parent, "Return exactly RECOVERY_SCHEMA_AFTER_RELOAD");
					await waitUntil(() => getProviderRequests().some((request) => request.userText.includes("Return exactly RECOVERY_SCHEMA_AFTER_RELOAD")), "reloaded receiver must send its current schema");
					const request = getProviderRequests().find((request) => request.userText.includes("Return exactly RECOVERY_SCHEMA_AFTER_RELOAD"))!;
					assert.deepEqual(Object.keys(request.toolParameters.replicate.properties ?? {}).sort(), ["continuation", "mode", "name", "task"]);

					const copiedFile = join(env.dir, "copied-recovery.jsonl");
					const rows = entries(parentFile);
					rows[0] = { ...rows[0], id: randomUUID() };
					writeFileSync(copiedFile, rows.map((row) => JSON.stringify(row)).join("\n") + "\n");
					const foreign = createTrackedSurface(env, "copied-recovery");
					await waitForPaneReady(foreign);
					startPi(foreign, env.dir, "Return exactly COPIED_SCHEMA_READY", { extraArgs: `--session ${shellQuote(copiedFile)} -e ${shellQuote(capability)}` });
					await waitUntil(() => getProviderRequests().some((item) => item.userText === "Return exactly COPIED_SCHEMA_READY"), "copied session must send its own fresh schema");
					const copiedRequest = getProviderRequests().find((item) => item.userText === "Return exactly COPIED_SCHEMA_READY")!;
					assert.deepEqual(Object.keys(copiedRequest.toolParameters.replicate.properties ?? {}), ["name", "task"]);
					closePane(foreign);
				}
				assert.equal(failed.details.integration.status, "not-attempted");
				assert.equal(existsSync(join(env.dir, "outstanding.txt")), false);
				const binding = readSessionBinding(failed.details.sessionFile)!;
				const location = childSessionLocation(binding.child!.lineage.rootDir, binding.child!.lineage.nodeId)!;
				await waitUntil(() => !sessionLocationAlive(location), "old attempt must exit before explicit recovery");
				runInPane(parent, `Call the replicate tool once with continuation: "${failed.details.continuationId}", mode: "${mode}", task: "Use replication_probe then Return exactly RECOVERY_SUMMARY"`);
				const launches = () => entries(parentFile).filter((row) => row.message?.role === "toolResult" && row.message.toolName === "replicate");
				await waitUntil(() => launches().length === 2, "the continuation launch must settle");
				assert.equal(launches()[1].message.isError, false, JSON.stringify(launches()[1].message));
				await waitUntil(() => results().length === 2, "recovered result must reach the requester");
				const recovered = results()[1], oldHeader = entries(failed.details.sessionFile)[0], newHeader = entries(recovered.details.sessionFile)[0];
				assert.match(recovered.content, /RECOVERY_SUMMARY/);
				assert.equal(recovered.details.integration.status, "applied");
				assert.equal(readFileSync(join(env.dir, "outstanding.txt"), "utf8"), "step\nstep\n");
				if (mode === "resume") assert.equal(newHeader.id, oldHeader.id);
				else assert.notEqual(newHeader.id, oldHeader.id);
				assert.notEqual(recovered.details.continuationId, failed.details.continuationId, "attempt results remain distinct");
				const request = getProviderRequests().find((item) => item.userText.includes("Your assignment:") && item.userText.includes("RECOVERY_SUMMARY"));
				assert.ok(request);
				assert.match(request.text, /SAVED_CONVERSATION_FACT/);
				assert.equal(await waitForPaneAbsence(childSessionLocation(readSessionBinding(recovered.details.sessionFile)!.child!.lineage.rootDir, readSessionBinding(recovered.details.sessionFile)!.child!.lineage.nodeId)!.paneId!, { timeoutMs: 10_000 }), true);
			});
		}
		it("keeps explicit task names and origins across reload in sessions and results", async () => {
			const parentFile = join(env.dir, "named-original.jsonl"), capability = join(env.dir, "naming-capability.ts"), settled = join(env.dir, ".pi", "agent", "naming-settled");
			writeFileSync(capability, `import {writeFileSync} from 'node:fs'; export default function(pi){if(process.env.PI_SUBAGENT_REPLICATION!=='1'){pi.on('session_start',()=>pi.setSessionName('Настройки'));pi.on('agent_settled',(_event,ctx)=>writeFileSync(${JSON.stringify(settled)},String(ctx.sessionManager.getEntries().filter(row=>row.type==='custom_message'&&row.customType==='subagent_result').length)));}}\n`);
			const parent = createTrackedSurface(env, "pane-name-is-not-the-session-name");
			await waitForPaneReady(parent);
			const ide = process.env.PI_INTEGRATION_IDE_ENTRY;
			startPi(parent, env.dir, "", { extraArgs: `--session ${shellQuote(parentFile)} -e ${shellQuote(capability)}` });
			await waitForScreen(parent, /Настройки/);
			runInPane(parent, "Return exactly NAMING_READY");
			try {
				await waitUntil(() => entries(parentFile).some((row) => row.message?.role === "assistant"), "parent ready");
			} catch (error) {
				assert.fail(`${error}\n${await waitForScreen(parent, /[\s\S]/, 1)}`);
			}
			if (ide) {
				const request = getProviderRequests().find((item) => item.userText === "Return exactly NAMING_READY")!;
				assert.ok(request.toolParameters.read?.properties?.views, "naming verification must load the current IDE read tool");
			}
			const results = () => entries(parentFile).filter((row) => row.customType === "subagent_result");
			for (const number of [1, 2]) {
				if (number === 2) {
					await waitUntil(() => existsSync(settled) && readFileSync(settled, "utf8") === "1", "parent must finish handling the first result before reload");
					runInPane(parent, "/reload");
					await waitForScreen(parent, /Reloaded keybindings, extensions/, PI_TIMEOUT);
				}
				runInPane(parent, 'Call the replicate tool once with name: "check-source", task: "Return exactly EMPTY_COMPLETION"');
				const launches = () => entries(parentFile).filter((row) => row.message?.role === "toolResult" && row.message.toolName === "replicate");
				await waitUntil(() => launches().length === number, "copy launch must be saved");
				const launch = launches().at(-1);
				assert.equal(launch.message.isError, false, JSON.stringify(launch.message));
				await waitUntil(() => results().length === number, "named result must reach the parent");
				const expected = "check-source ← Настройки";
				assert.equal(launch.message.details.name, expected);
				const work = readReplicaWork(readSessionBinding(launch.message.details.sessionFile)!.child!.environment.PI_SUBAGENT_REPLICA_WORK_FILE);
				const expectedBranch = `replica/nastroiki/check-source${number === 1 ? "" : "-2"}`;
				assert.equal(work.worktree!.branch, expectedBranch);
				assert.ok(work.worktree!.path.endsWith(expectedBranch.replaceAll("/", "-")), work.worktree!.path);
				assert.ok(launch.message.content.some((part: any) => part.text?.includes(expected)));
				assert.ok(results().at(-1).content.includes(expected));
				assert.equal(entries(launch.message.details.sessionFile).filter((row) => row.type === "session_info").at(-1).name, expected);
			}
		});
		it("joins two isolated siblings without dropping current parent work or staging", async () => {
			const parentFile = join(env.dir, "siblings-original.jsonl"), capability = join(env.dir, "siblings-capability.ts");
			const gate = join(env.dir, ".pi", "agent", "siblings-gate"), markers = gate + ".started";
			mkdirSync(markers);
			writeFileSync(capability, `import {Type} from ${JSON.stringify(new URL("../../node_modules/@sinclair/typebox/build/esm/index.mjs", import.meta.url).pathname)}; import {existsSync,writeFileSync} from 'node:fs'; import {join} from 'node:path'; export default function(pi){pi.registerTool({name:'replication_probe',label:'Probe',description:'Write isolated sibling source',parameters:Type.Object({}),async execute(){const id=process.env.PI_SUBAGENT_ID;writeFileSync(join(process.cwd(),id+'.txt'),id);writeFileSync(join(${JSON.stringify(markers)},id),'ready');const end=Date.now()+${PI_TIMEOUT};while(!existsSync(${JSON.stringify(gate)})&&Date.now()<end)await new Promise(r=>setTimeout(r,25));if(!existsSync(${JSON.stringify(gate)}))throw new Error('gate timeout');return {content:[{type:'text',text:'sibling source written'}],details:{}}}});}\n`);
			const parent = createTrackedSurface(env, "siblings-original");
			await waitForPaneReady(parent);
			startPi(parent, env.dir, "Return exactly SIBLINGS_READY", { extraArgs: `--session ${shellQuote(parentFile)} -e ${shellQuote(capability)}` });
			await waitUntil(() => entries(parentFile).some((row) => row.message?.role === "assistant"), "parent ready");
			runInPane(parent, 'Call the replicate tool once with task: "Use replication_probe then Return exactly FIRST_SIBLING"');
			await waitUntil(() => readdirSync(markers).length === 1, "first sibling started");
			runInPane(parent, 'Call the replicate tool once with task: "Use replication_probe then Return exactly SECOND_SIBLING"');
			await waitUntil(() => readdirSync(markers).length === 2, "second sibling started without sharing source");
			const ids = readdirSync(markers);
			for (const id of ids) assert.equal(existsSync(join(env.dir, id + ".txt")), false);
			writeFileSync(join(env.dir, "parent.txt"), "parent staged");
			execFileSync("git", ["add", "parent.txt"], { cwd: env.dir });
			writeFileSync(join(env.dir, "parent.txt"), "parent working");
			const index = readFileSync(join(env.dir, ".git", "index"));
			writeFileSync(gate, "go");
			await waitUntil(() => entries(parentFile).filter((row) => row.customType === "subagent_result").length === 2, "both sibling results must join");
			for (const result of entries(parentFile).filter((row) => row.customType === "subagent_result")) assert.equal(result.details.integration.status, "applied");
			for (const id of ids) assert.equal(readFileSync(join(env.dir, id + ".txt"), "utf8"), id);
			assert.equal(readFileSync(join(env.dir, "parent.txt"), "utf8"), "parent working");
			assert.deepEqual(readFileSync(join(env.dir, ".git", "index")), index);
			for (const result of entries(parentFile).filter((row) => row.customType === "subagent_result")) {
				const binding = readSessionBinding(result.details.sessionFile)!;
				await waitUntil(() => readReplicaWork(binding.child!.environment.PI_SUBAGENT_REPLICA_WORK_FILE).cleaned === true, "each applied sibling must finish durable cleanup");
				await assertReplicaSurfaceClosed(result);
			}
		});
		it("reports a host join conflict without applying any child file or replacing parent staging", async () => {
			const parentFile = join(env.dir, "conflict-original.jsonl"), capability = join(env.dir, "conflict-capability.ts");
			const gate = join(env.dir, ".pi", "agent", "conflict-release"), started = gate + ".started";
			writeFileSync(join(env.dir, "collision.txt"), "base\n");
			writeFileSync(capability, `import {Type} from ${JSON.stringify(new URL("../../node_modules/@sinclair/typebox/build/esm/index.mjs", import.meta.url).pathname)}; import {existsSync,writeFileSync} from 'node:fs'; import {join} from 'node:path'; export default function(pi){pi.registerTool({name:'replication_probe',label:'Probe',description:'Write gated child files',parameters:Type.Object({}),async execute(){writeFileSync(join(process.cwd(),'collision.txt'),'child\\n');writeFileSync(join(process.cwd(),'child-only.txt'),'retained');writeFileSync(${JSON.stringify(started)},'ready');const deadline=Date.now()+${PI_TIMEOUT};while(!existsSync(${JSON.stringify(gate)})&&Date.now()<deadline)await new Promise(r=>setTimeout(r,25));if(!existsSync(${JSON.stringify(gate)}))throw new Error('gate timeout');return {content:[{type:'text',text:'CAPABILITY_INHERITED'}],details:{}}}});}\n`);
			const parent = createTrackedSurface(env, "conflict-original");
			await waitForPaneReady(parent);
			startPi(parent, env.dir, "Return exactly CONFLICT_READY", { extraArgs: `--session ${shellQuote(parentFile)} -e ${shellQuote(capability)}` });
			await waitUntil(() => entries(parentFile).some((row) => row.message?.role === "assistant"), "parent ready");
			runInPane(parent, 'Call the replicate tool once with task: "Use replication_probe then Return exactly CONFLICT_TASK_FINISHED"');
			await waitUntil(() => existsSync(started), "child must have written its isolated files");
			writeFileSync(join(env.dir, "collision.txt"), "parent staged\n");
			execFileSync("git", ["add", "collision.txt"], { cwd: env.dir });
			writeFileSync(join(env.dir, "collision.txt"), "parent working\n");
			const index = readFileSync(join(env.dir, ".git", "index")), head = execFileSync("git", ["rev-parse", "HEAD"], { cwd: env.dir, encoding: "utf8" });
			writeFileSync(gate, "go");
			await waitUntil(() => entries(parentFile).some((row) => row.customType === "subagent_result"), "conflict must return task summary and retained pointer");
			const result = entries(parentFile).find((row) => row.customType === "subagent_result");
			assert.match(result.content, /completed[\s\S]*CONFLICT_TASK_FINISHED/);
			assert.equal(result.details.integration.status, "conflict");
			assert.equal(result.details.recoveryAvailable, true);
			assert.ok(result.content.includes(result.details.continuationId));
			assert.equal(readFileSync(join(env.dir, "collision.txt"), "utf8"), "parent working\n");
			assert.equal(existsSync(join(env.dir, "child-only.txt")), false);
			assert.deepEqual(readFileSync(join(env.dir, ".git", "index")), index);
			assert.equal(execFileSync("git", ["rev-parse", "HEAD"], { cwd: env.dir, encoding: "utf8" }), head);
			assert.equal(readFileSync(join(result.details.worktreePath, "child-only.txt"), "utf8"), "retained");
			await assertReplicaSurfaceClosed(result);
			assert.equal(readFileSync(join(result.details.worktreePath, "child-only.txt"), "utf8"), "retained", "closing the conflicted pane must retain its source");
		});
		it("rebuilds an applied cleaned continuation without reapplying its old changes", async () => {
			const parentFile = join(env.dir, "cleaned-original.jsonl"), capability = join(env.dir, "cleaned-capability.ts");
			writeFileSync(capability, `import {Type} from ${JSON.stringify(new URL("../../node_modules/@sinclair/typebox/build/esm/index.mjs", import.meta.url).pathname)}; import {existsSync,writeFileSync} from 'node:fs'; import {join} from 'node:path'; export default function(pi){pi.registerTool({name:'replication_probe',label:'Probe',description:'Write a new source file',parameters:Type.Object({}),async execute(){const old=join(process.cwd(),'old.txt');writeFileSync(existsSync(old)?join(process.cwd(),'new.txt'):old,'CHILD');return {content:[{type:'text',text:'CAPABILITY_INHERITED'}],details:{}}}});}\n`);
			const parent = createTrackedSurface(env, "cleaned-original");
			await waitForPaneReady(parent);
			startPi(parent, env.dir, "Return exactly CLEANED_READY", { extraArgs: `--session ${shellQuote(parentFile)} -e ${shellQuote(capability)}` });
			await waitUntil(() => entries(parentFile).some((row) => row.message?.role === "assistant"), "parent ready");
			runInPane(parent, 'Call the replicate tool once with task: "Use replication_probe then Return exactly FIRST_APPLIED"');
			const results = () => entries(parentFile).filter((row) => row.customType === "subagent_result");
			await waitUntil(() => results().length === 1, "first work must join");
			const first = results()[0];
			assert.equal(first.details.integration.status, "applied");
			await waitUntil(() => !existsSync(first.details.worktreePath), "successful worktree must disappear before recovery");
			writeFileSync(join(env.dir, "old.txt"), "PARENT_LATER");
			runInPane(parent, `Call the replicate tool once with continuation: "${first.details.continuationId}", mode: "fork", task: "Use replication_probe then Return exactly NEXT_APPLIED"`);
			await waitUntil(() => results().length === 2, "cleaned continuation must be reconstructed");
			assert.equal(results()[1].details.integration.status, "applied");
			assert.equal(readFileSync(join(env.dir, "old.txt"), "utf8"), "PARENT_LATER");
			assert.equal(readFileSync(join(env.dir, "new.txt"), "utf8"), "CHILD");
		});
		for (const outcome of ["applied", "failed"]) it(`renders an active isolated replica and its ${outcome} result after native reload`, { skip: !process.env.PI_INTEGRATION_TUI_DIR }, async () => {
			const inspection = join(process.env.PI_INTEGRATION_TUI_DIR!, outcome);
			const ide = process.env.PI_INTEGRATION_IDE_ENTRY;
			assert.ok(ide && existsSync(ide), "visual verification requires the current IDE source");
			mkdirSync(inspection, { recursive: true });
			const parentFile = join(env.dir, "visual-original.jsonl"), capability = join(env.dir, "visual-capability.ts");
			writeFileSync(capability, `import {Type} from ${JSON.stringify(new URL("../../node_modules/@sinclair/typebox/build/esm/index.mjs", import.meta.url).pathname)};
import {existsSync,readFileSync,writeFileSync} from 'node:fs'; import {join} from 'node:path';
const inspection=${JSON.stringify(inspection)};
export default function(pi){
  if(process.env.PI_SUBAGENT_REPLICATION!=='1') pi.on('session_start',()=>{
    pi.setSessionName('Настройки');
    const file=join(inspection,'runtime.json');
    const starts=existsSync(file)?JSON.parse(readFileSync(file,'utf8')).starts:0;
    const read=pi.getAllTools().find(tool=>tool.name==='read');
    writeFileSync(file,JSON.stringify({starts:starts+1,readHasViews:!!read?.parameters?.properties?.views,replicateFields:Object.keys(pi.getAllTools().find(tool=>tool.name==='replicate')?.parameters?.properties??{}),argv:process.argv,ideSource:process.env.PI_INTEGRATION_IDE_SOURCE_COMMIT,ideVersion:process.env.PI_INTEGRATION_IDE_PACKAGE_VERSION}));
  });
  pi.registerTool({name:'replication_probe',label:'Probe',description:'Write isolated work and hold it for visual inspection',parameters:Type.Object({}),async execute(){
    writeFileSync(join(process.cwd(),'visual-change.txt'),'VISUAL_CHILD_EDIT');
    writeFileSync(join(inspection,'child-active.json'),JSON.stringify({cwd:process.cwd(),pid:process.pid}));
    const deadline=Date.now()+300000;
    while(!existsSync(join(inspection,'release-child'))){if(Date.now()>deadline)throw new Error('visual inspection release timed out');await new Promise(resolve=>setTimeout(resolve,50));}
    return {content:[{type:'text',text:'CAPABILITY_INHERITED'}],details:{}};
  }});
}
`);
			const parent = createTrackedSurface(env, "visual-original");
			await waitForPaneReady(parent);
			startPi(parent, env.dir, "Return exactly VISUAL_READY", { extraArgs: `--session ${shellQuote(parentFile)} -e ${shellQuote(capability)}` });
			await waitUntil(() => entries(parentFile).some((row) => row.message?.role === "assistant"), "native parent ready");
			runInPane(parent, "/reload");
			await waitUntil(() => existsSync(join(inspection, "runtime.json")) && JSON.parse(readFileSync(join(inspection, "runtime.json"), "utf8")).starts >= 2, "the native reload must reattach the same source");
			await waitForScreen(parent, /Reloaded keybindings, extensions/, PI_TIMEOUT);
			assert.equal(JSON.parse(readFileSync(join(inspection, "runtime.json"), "utf8")).readHasViews, true, "the loaded read tool must be IDE's native tool, not Pi's built-in reader");
			assert.deepEqual(JSON.parse(readFileSync(join(inspection, "runtime.json"), "utf8")).replicateFields, ["name", "task"]);
			runInPane(parent, `INTEGRATION_VISUAL_PARENT. Call the replicate tool once with task: "Use replication_probe then Return exactly ${outcome === "applied" ? "REPLICATION_SUMMARY" : "EMPTY_COMPLETION"}"`);
			await waitUntil(() => existsSync(join(inspection, "child-active.json")), "child active in isolated checkout");
			assert.notEqual(JSON.parse(readFileSync(join(inspection, "child-active.json"), "utf8")).cwd, env.dir);
			await waitUntil(() => entries(parentFile).some((row) => row.message?.role === "toolResult" && row.message.toolName === "replicate"), "copy launch must be saved");
			const launch = entries(parentFile).find((row) => row.message?.role === "toolResult" && row.message.toolName === "replicate");
			assert.equal(launch.message.details.name, "integration-copy ← Настройки");
			assert.equal(entries(launch.message.details.sessionFile).filter((row) => row.type === "session_info").at(-1).name, launch.message.details.name);
			const active = await waitForScreen(parent, /1 active/, 20_000);
			writeFileSync(join(inspection, "active.txt"), active);
			writeFileSync(join(inspection, "pane.json"), JSON.stringify({ stage: "active", pane: parent, config: process.env.HERDR_CONFIG_PATH, socket: process.env.HERDR_SOCKET_PATH }));
			const releaseDeadline = Date.now() + 300_000;
			while (!existsSync(join(inspection, "release-child"))) { assert.ok(Date.now() < releaseDeadline, "visual observer must release the child"); await sleep(100); }
			await waitUntil(() => entries(parentFile).some((row) => row.customType === "subagent_result"), "one saved result must wake the parent");
			const results = entries(parentFile).filter((row) => row.customType === "subagent_result");
			assert.equal(results.length, 1);
			assert.match(results[0].content, outcome === "applied" ? /REPLICATION_SUMMARY/ : /no required summary/);
			assert.match(results[0].content, /integration-copy ← Настройки/);
			assert.equal(results[0].details.integration.status, outcome === "applied" ? "applied" : "not-attempted");
			await assertReplicaSurfaceClosed(results[0]);
			const sourceDir = outcome === "applied" ? env.dir : results[0].details.worktreePath;
			assert.equal(readFileSync(join(sourceDir, "visual-change.txt"), "utf8"), "VISUAL_CHILD_EDIT");
			const delivered = await waitForScreen(parent, outcome === "applied" ? /REPLICATION_SUMMARY/ : /no required summary/, 20_000);
			writeFileSync(join(inspection, "delivered.txt"), delivered);
			writeFileSync(join(inspection, "result.json"), JSON.stringify(results[0]));
			writeFileSync(join(inspection, "pane.json"), JSON.stringify({ stage: "delivered", pane: parent, config: process.env.HERDR_CONFIG_PATH, socket: process.env.HERDR_SOCKET_PATH }));
			const finishDeadline = Date.now() + 300_000;
			while (!existsSync(join(inspection, "finish"))) { assert.ok(Date.now() < finishDeadline, "visual observer must finish before cleanup"); await sleep(100); }
		});
		it("forks the current conversation with one inherited tool surface and returns one summary", async () => {
			const parentFile = join(env.dir, "original.jsonl");
			const capability = join(env.dir, "parent-only-capability.ts");
			writeFileSync(join(env.dir, "snapshot-source.txt"), "FORK_FILE");
			writeFileSync(capability, `import { Type } from ${JSON.stringify(new URL("../../node_modules/@sinclair/typebox/build/esm/index.mjs", import.meta.url).pathname)};\nimport {writeFileSync} from 'node:fs'; import {join} from 'node:path'; export default function(pi) { pi.on('before_agent_start', (event) => ({systemPrompt: event.systemPrompt + '\\nCUSTOM_CAPABILITY_SYSTEM'})); pi.registerTool({name:'replication_probe',label:'Probe',description:'Verify inherited capability',parameters:Type.Object({}),async execute(){writeFileSync(join(process.cwd(),'replica-change.txt'),'CHILD_EDIT');return {content:[{type:'text',text:'CAPABILITY_INHERITED'}],details:{}}}}); }\n`);
			const parent = createTrackedSurface(env, "replication-original");
			await waitForPaneReady(parent);
			startPi(parent, env.dir, "Earlier fact: EARLIER_REPLICATION_CONTEXT. Return exactly ORIGINAL_READY", { extraArgs: `--session ${shellQuote(parentFile)} -e ${shellQuote(capability)}` });
			await waitUntil(() => entries(parentFile).some((entry) => entry.message?.role === "assistant" && JSON.stringify(entry.message.content).includes("ORIGINAL_READY")), "the original must persist its initial answer, not just echo the input");
			const first = getProviderRequests()[0];
			assert.deepEqual(first.tools.filter((name) => packageTools.has(name)), ["replicate"]);
			assert.deepEqual(Object.keys(first.toolParameters.replicate.properties ?? {}), ["name", "task"]);

			runInPane(parent, 'Current fact: CURRENT_REPLICATION_CONTEXT. Call the replicate tool once with task: "Use replication_probe then Return exactly REPLICATION_SUMMARY"');
			await waitUntil(() => entries(parentFile).some((entry) => entry.type === "custom_message" && entry.customType === "subagent_result"), "the original must receive its clone summary");
			const deliveries = entries(parentFile).filter((entry) => entry.type === "custom_message" && entry.customType === "subagent_result");
			assert.equal(deliveries.length, 1);
			assert.match(deliveries[0].content, /REPLICATION_SUMMARY/);
			assert.equal(deliveries[0].content, deliveries[0].details.resultContent);
			assert.equal(deliveries[0].details.recoveryAvailable, true);
			assert.ok(deliveries[0].content.includes(deliveries[0].details.continuationId));
			assert.ok(existsSync(deliveries[0].details.resultPath));
			const childFile = deliveries[0].details.sessionFile;
			const started = entries(parentFile).find((row) => row.message?.role === "toolResult" && row.message.toolName === "replicate");
			assert.equal(started.message.details.name, "integration-copy ← replication-original", "an unnamed session uses its current pane name");
			assert.match(deliveries[0].content, /integration-copy ← replication-original/);
			const binding = readSessionBinding(childFile);
			assert.ok(binding?.child);
			assert.notEqual(entries(childFile)[0].cwd, env.dir, "the clone must own a separate worktree");
			assert.equal(execFileSync("git", ["show", `${deliveries[0].details.checkpoint}:snapshot-source.txt`], { cwd: env.dir, encoding: "utf8" }), "FORK_FILE", "the source snapshot remains after cleanup");
			assert.equal(deliveries[0].details.integration.status, "applied");
			assert.equal(readFileSync(join(env.dir, "replica-change.txt"), "utf8"), "CHILD_EDIT");
			const childRequest = getProviderRequests().find((request) => request.userText.includes("REPLICATION_SUMMARY") && !request.userText.includes("Call the replicate tool"));
			assert.ok(childRequest, "the clone must make a real provider request");
			assert.match(childRequest.text, /EARLIER_REPLICATION_CONTEXT/);
			assert.match(childRequest.text, /CURRENT_REPLICATION_CONTEXT/);
			assert.equal(systemText(childRequest), systemText(first));
			assert.equal(childRequest.model, first.model);
			assert.deepEqual(childRequest.tools, first.tools);
			assert.ok(entries(childFile).some((entry) => entry.message?.role === "toolResult" && entry.message.toolName === "replication_probe" && JSON.stringify(entry.message.content).includes("CAPABILITY_INHERITED")), "the inherited custom tool must actually execute");
			assert.deepEqual(childRequest.tools.filter((name) => packageTools.has(name)), ["replicate"]);
			assert.deepEqual(Object.keys(childRequest.toolParameters.replicate.properties ?? {}), ["name", "task"]);
			for (const hidden of [deliveries[0].details.resultPath, childFile, deliveries[0].details.worktreePath, deliveries[0].details.checkpoint]) assert.equal(deliveries[0].content.includes(hidden), false);
			const location = childSessionLocation(binding.child.lineage.rootDir, binding.child.lineage.nodeId);
			assert.ok(location?.paneId);
			assert.equal(await waitForPaneAbsence(location.paneId, { timeoutMs: 10_000 }), true);
			assert.equal(existsSync(entries(childFile)[0].cwd), false, "successful joined worktrees are cleaned");
			await assertReplicaSurfaceClosed(deliveries[0]);
			// The clone closes only its own surface, not the original's.
			runInPane(parent, "Return exactly ORIGINAL_STILL_OPEN");
			await waitForScreen(parent, /ORIGINAL_STILL_OPEN/);
			const afterResult = getProviderRequests().find((request) => request.userText.includes("Return exactly ORIGINAL_STILL_OPEN"))!;
			assert.ok(afterResult);
			assert.deepEqual(Object.keys(afterResult.toolParameters.replicate.properties ?? {}).sort(), ["continuation", "mode", "name", "task"]);
			closePane(parent);
		});
	});
}
