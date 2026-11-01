import { afterEach, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { reduceLineage, type LineageNodeState } from "../../pi-extension/subagents/lineage.ts";
import { parentSessionLocation, childSessionLocation, sessionLocationAlive, readSessionBinding, sessionLineageRoots } from "../../pi-extension/subagents/session-binding.ts";
import { getProviderRequests } from "./fake-provider.ts";
import {
	cleanupTestEnv, createTestEnv, createTrackedSurface, getAvailableBackends,
	closePane, readPane, runInPane, shellQuote, sleep, startPi, waitForFile,
	waitForPaneReady, waitForPiExit, waitForScreen, restartIsolatedHerdr, PI_TIMEOUT, type TestEnv,
} from "./harness.ts";

function entries(file: string): any[] {
	if (!existsSync(file)) return [];
	return readFileSync(file, "utf8").trim().split("\n").map((line) => JSON.parse(line));
}
function results(file: string): any[] {
	return entries(file).filter((entry) => entry.type === "custom_message" && entry.customType === "subagent_result");
}
async function waitUntil(check: () => boolean, explanation: string, timeout = PI_TIMEOUT): Promise<void> {
	const deadline = Date.now() + timeout;
	while (Date.now() < deadline) {
		if (check()) return;
		await sleep(50);
	}
	assert.fail(explanation);
}
/** Teleport copies every entry, keeps the ID, changes cwd, and removes the source file. */
function moveSession(source: string, destination: string, cwd: string, remove = true): void {
	const rows = entries(source);
	assert.equal(rows[0].type, "session");
	rows[0].cwd = cwd;
	writeFileSync(destination, rows.map((row) => JSON.stringify(row)).join("\n") + "\n");
	if (remove) rmSync(source);
}
function ownedNodes(file: string): LineageNodeState[] {
	const binding = readSessionBinding(file);
	if (!binding) return [];
	return sessionLineageRoots(binding.storeDir, binding.sessionId).flatMap((root) => [...reduceLineage(root).nodes.values()]);
}
function gatedTask(started: string, gate: string, answer: string): string {
	return `Run this bash command: echo 'START_MOBILE' > '${started}'; while ! test -f '${gate}'; do sleep 0.1; done; echo '${answer}'\nAfter the tool, Return exactly ${answer}`;
}
const teleportSource = process.env.PI_TEST_TELEPORT_SOURCE;

/** Give every real Teleport destination the same isolated package and provider. */
function installTeleport(env: TestEnv): string {
	assert.ok(teleportSource && existsSync(teleportSource));
	const agentDir = join(env.dir, ".pi", "agent");
	const wrapper = join(agentDir, "extensions", "teleport-under-test.ts");
	writeFileSync(wrapper, `export { default } from ${JSON.stringify(teleportSource)};\n`);
	const serverAgentDir = process.env.PI_INTEGRATION_HERDR_AGENT_DIR;
	assert.ok(serverAgentDir, "Teleport needs the runner-owned agent directory");
	cpSync(agentDir, serverAgentDir, { recursive: true });
	return wrapper;
}

for (const backend of getAvailableBackends()) {
	describe(`session moves (${backend})`, { timeout: PI_TIMEOUT * 6 }, () => {
		let env: TestEnv;
		beforeEach(() => { env = createTestEnv(backend); });
		afterEach(async () => { await cleanupTestEnv(env); });

		it("delivers once after the parent file and process move and the old file disappears", async () => {
			const original = join(env.dir, "parent.jsonl");
			const destinationDir = join(env.dir, "destination");
			mkdirSync(destinationDir);
			const moved = join(destinationDir, "parent.jsonl");
			const gate = join(env.dir, "release-child");
			const started = join(env.dir, "child-started");
			const parent = createTrackedSurface(env, "mobile-parent");
			await waitForPaneReady(parent);
			startPi(parent, env.dir, [
				"Call the subagent tool with these EXACT parameters:",
				'name: "mobile-child"', 'agent: "test-echo"',
				`task: ${JSON.stringify(gatedTask(started, gate, "MOBILE_ANSWER"))}`,
				"Do not do anything else. Just call the subagent tool once.",
			].join("\n"), { extraArgs: `--session ${shellQuote(original)}` });
			await waitForFile(started);
			runInPane(parent, "/quit");
			await waitForPiExit(parent);
			closePane(parent);
			moveSession(original, moved, destinationDir);

			const receiver = createTrackedSurface(env, "moved-parent");
			await waitForPaneReady(receiver);
			startPi(receiver, env.dir, "Return exactly MOBILE_PARENT_OPEN", { extraArgs: `--session ${shellQuote(moved)}` });
			await waitForScreen(receiver, /MOBILE_PARENT_OPEN/);
			writeFileSync(gate, "go");
			await waitUntil(() => results(moved).length === 1, `No result reached the moved parent: ${readPane(receiver, 250)}`, 20_000);
			assert.match(results(moved)[0].content, /MOBILE_ANSWER/);
			assert.equal(typeof results(moved)[0].details.deliveryId, "string");
			assert.ok(existsSync(results(moved)[0].details.resultPath));
			await waitUntil(() => getProviderRequests().some((request) => request.userText.includes("Subagent mobile-child completed.")), "delivery must wake the parent agent");
			runInPane(receiver, "/quit");
			await waitForPiExit(receiver);
			const reopened = createTrackedSurface(env, "reopened-parent");
			await waitForPaneReady(reopened);
			startPi(reopened, env.dir, "Return exactly MOBILE_PARENT_REOPEN", { extraArgs: `--session ${shellQuote(moved)}` });
			await waitForScreen(reopened, /MOBILE_PARENT_REOPEN/);
			assert.equal(results(moved).length, 1, "an acknowledged result must not replay");
			runInPane(reopened, "/quit");
			await waitForPiExit(reopened);
		});

		it("follows a moved child owning a grandchild and drains only through its immediate parent", async () => {
			const original = join(env.dir, "root.jsonl");
			const gate = join(env.dir, "grandchild-gate");

			if (teleportSource) {
				installTeleport(env);
				const role = join(env.dir, ".pi", "agents", "test-descendant-owner.md");
				writeFileSync(role, readFileSync(role, "utf8").replace(/^tools:.*$/m, "tools: subagent, subagent_done, teleport"));
			}
			const parent = createTrackedSurface(env, "nested-root");
			await waitForPaneReady(parent);
			startPi(parent, env.dir, [
				"Call the subagent tool with these EXACT parameters:",
				'name: "moving-owner"', 'agent: "test-descendant-owner"',
				`task: "INTEGRATION_DESCENDANT_GATE: ${gate} Launch the descendant and stay open."`,
				"Call the tool once and wait for its asynchronous result.",
			].join("\n"), {
				extraArgs: `--session ${shellQuote(original)}`,
				...(teleportSource ? { agentDir: process.env.PI_INTEGRATION_HERDR_AGENT_DIR } : {}),
			});
			await waitUntil(() => ownedNodes(original).length === 2, "the owner must launch its grandchild");
			const owner = ownedNodes(original).find((node) => node.name === "moving-owner");
			assert.ok(owner?.sessionFile && owner.surface);
			await waitForScreen(owner.surface, /Nested-[^\s]+[\s\S]*active/i);
			const destinationDir = join(env.dir, "moved-child");
			mkdirSync(destinationDir);
			let moved = join(destinationDir, "owner.jsonl");
			const ownerBinding = readSessionBinding(owner.sessionFile)!;
			const sourcePid = parentSessionLocation(ownerBinding.storeDir, ownerBinding.sessionId)!.pid;

			if (teleportSource) {
				runInPane(owner.surface, `Call the teleport tool with EXACT parameters: action: "jump" target: "${destinationDir}"`);
				await waitUntil(() => parentSessionLocation(ownerBinding.storeDir, ownerBinding.sessionId)?.cwd === destinationDir, "the nested owner must Teleport");
				moved = parentSessionLocation(ownerBinding.storeDir, ownerBinding.sessionId)!.sessionFile;
				await waitUntil(() => !existsSync(owner.sessionFile!), "Teleport removes the old owner file");
			} else {
				moveSession(owner.sessionFile, moved, destinationDir, false);
				const receiver = createTrackedSurface(env, "moved-owner");
				await waitForPaneReady(receiver);
				startPi(receiver, env.dir, "Return exactly OWNER_MOVED", { extraArgs: `--session ${shellQuote(moved)}` });
				await waitForScreen(receiver, /OWNER_MOVED/);
				runInPane(owner.surface, "/quit");
				await waitUntil(() => !existsSync(`/proc/${sourcePid}`), "source process must exit");
				closePane(owner.surface);
				rmSync(owner.sessionFile);
			}
			assert.equal(results(original).length, 0, "the root cannot finish its owner while the grandchild is active");
			writeFileSync(gate, "go");
			await waitUntil(() => results(moved).length === 1, "grandchild must reach its moved immediate parent", 30_000);
			await waitUntil(() => results(original).length === 1, `owner must drain and reach root: ${readPane(parent, 250)}`, 30_000);
			assert.match(results(moved)[0].content, /GRANDCHILD_DONE/);
			assert.match(results(original)[0].content, /OWNER_FINAL/);
			assert.equal(results(original)[0].details.childId, owner.nodeId);
			runInPane(parent, "/quit");
			await waitForPiExit(parent);
		});

		it("lets an autonomous child finish in its Teleport destination, not during the source handoff", { skip: !teleportSource }, async () => {
			installTeleport(env);
			const role = join(env.dir, ".pi", "agents", "test-echo.md");
			writeFileSync(role, readFileSync(role, "utf8").replace(/^tools:.*$/m, "tools: bash, teleport"));
			const destination = join(env.dir, "autonomous-destination");
			mkdirSync(destination);
			const original = join(env.dir, "autonomous-parent.jsonl");
			const parent = createTrackedSurface(env, "autonomous-parent");
			await waitForPaneReady(parent);
			startPi(parent, env.dir, [
				"Call the subagent tool with these EXACT parameters:",
				'name: "autonomous-mobile"', 'agent: "test-echo"',
				`task: ${JSON.stringify(`Call the teleport tool with EXACT parameters: action: "jump" target: "${destination}"\nAfter the move, Return exactly AUTONOMOUS_MOVED_ANSWER`)}`,
				"Do not do anything else. Just call the subagent tool once.",
			].join("\n"), { agentDir: process.env.PI_INTEGRATION_HERDR_AGENT_DIR, extraArgs: `--session ${shellQuote(original)}` });
			await waitUntil(() => results(original).length === 1, `moved autonomous child must finish: ${readPane(parent, 250)}`, 40_000);
			const node = ownedNodes(original)[0];
			const binding = readSessionBinding(original)!;
			const root = sessionLineageRoots(binding.storeDir, binding.sessionId)[0];
			const location = childSessionLocation(root, node.nodeId)!;
			assert.equal(location.cwd, destination);
			assert.notEqual(location.sessionFile, node.sessionFile);
			assert.match(results(original)[0].content, /AUTONOMOUS_MOVED_ANSWER/);
			assert.equal(results(original)[0].details.sessionFile, location.sessionFile);
			if (location.paneId) env.surfaces.push(location.paneId);
			runInPane(parent, "/quit");
			await waitForPiExit(parent);
		});
		for (const boundary of ["saved-child", "queued-parent", "active-child"] as const) {
			it(`survives a complete isolated Herdr restart at ${boundary}`, async () => {
				const original = join(env.dir, "restart-parent.jsonl");
				const gate = join(env.dir, "restart-gate");
				const started = join(env.dir, "restart-started");
				const queued = join(env.dir, "queued-result");
				const parent = createTrackedSurface(env, "restart-parent");
				await waitForPaneReady(parent);
				startPi(parent, env.dir, [
					"Call the subagent tool with these EXACT parameters:",
					'name: "restart-child"', 'agent: "test-echo"',
					`task: ${JSON.stringify(gatedTask(started, gate, "RESTART_ANSWER"))}`,
					"Do not do anything else. Just call the subagent tool once.",
				].join("\n"), {
					extraArgs: `--session ${shellQuote(original)}`,
					...(boundary === "queued-parent" ? { environment: { PI_INTEG_QUEUE_RESULT_MARKER: queued } } : {}),
				});
				await waitForFile(started);
				const binding = readSessionBinding(original)!;
				const node = ownedNodes(original)[0];
				assert.ok(node.sessionFile);
				const root = sessionLineageRoots(binding.storeDir, binding.sessionId)[0];
				if (boundary === "queued-parent") {
					// Hold only the delivery sink to exercise queued-but-unpersisted receipt.
					writeFileSync(gate, "go");
					await waitForFile(queued);
					await waitUntil(() => Boolean(reduceLineage(root).nodes.get(node.nodeId)?.terminalDelivered), "child must publish its result while parent is still streaming");
					assert.equal(results(original).length, 0, "queued is not a persisted acknowledgement");
				} else if (boundary === "saved-child") {
					runInPane(parent, "/quit");
					await waitForPiExit(parent);
					closePane(parent);
					writeFileSync(gate, "go");
					await waitForFile(`${node.sessionFile}.exit`);
					assert.match(readFileSync(`${node.sessionFile}.exit`, "utf8"), /RESTART_ANSWER/);
					closePane(node.surface!);
				}
				await restartIsolatedHerdr(env);
				writeFileSync(gate, "go");
				const receiver = createTrackedSurface(env, "restart-receiver");
				await waitForPaneReady(receiver);
				startPi(receiver, env.dir, "", { extraArgs: `--session ${shellQuote(original)}` });
				await waitUntil(() => results(original).length === 1, `saved answer must reach reopened parent at ${boundary}: ${readPane(receiver, 250)}`, 40_000);
				if (boundary !== "active-child") assert.match(results(original)[0].content, /RESTART_ANSWER/);
				else assert.match(results(original)[0].content, /completed|failed|error|crashed/i, "active loss must recover or report an honest failure");
				assert.ok(existsSync(results(original)[0].details.resultPath));
				const childLocation = childSessionLocation(root, node.nodeId);
				if (childLocation?.paneId) env.surfaces.push(childLocation.paneId);
				await waitUntil(() => getProviderRequests().some((request) => request.userText.includes("Subagent restart-child")), "replay must wake the reopened parent without a user prompt");
				runInPane(receiver, "/quit");
				await waitForPiExit(receiver);
				const reopened = createTrackedSurface(env, "restart-second-receiver");
				await waitForPaneReady(reopened);
				startPi(reopened, env.dir, "Return exactly RESTART_REOPENED", { extraArgs: `--session ${shellQuote(original)}` });
				await waitForScreen(reopened, /RESTART_REOPENED/);
				assert.equal(results(original).length, 1);
				runInPane(reopened, "/quit");
				await waitForPiExit(reopened);
			});
		}
		it("real Teleport carries two children through jump and back without delivering to a copied fork", { skip: !teleportSource }, async () => {
			const teleportWrapper = installTeleport(env);
			const original = join(env.dir, "teleport-parent.jsonl");
			const destinationDir = join(env.dir, "destination");
			mkdirSync(destinationDir);
			execFileSync("git", ["init", "-q", "-b", "main"], { cwd: env.dir });
			execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: env.dir });
			execFileSync("git", ["config", "user.name", "Integration Test"], { cwd: env.dir });
			execFileSync("git", ["config", "commit.gpgsign", "false"], { cwd: env.dir });
			writeFileSync(join(env.dir, "README.md"), "session move fixture\n");
			execFileSync("git", ["add", "README.md"], { cwd: env.dir });
			execFileSync("git", ["commit", "-qm", "fixture"], { cwd: env.dir });
			const gate = join(env.dir, "release-both");
			const parent = createTrackedSurface(env, "teleport-parent");
			await waitForPaneReady(parent);
			startPi(parent, env.dir, [
				"Call the subagent tool twice with these EXACT parameters:",
				'name: "ordinary-mobile"', 'agent: "test-echo"',
				`task: ${JSON.stringify(gatedTask(join(env.dir, "ordinary-started"), gate, "ORDINARY_MOBILE_ANSWER"))}`,
				'name: "worktree-mobile"', 'agent: "test-echo"', 'worktree: { branch: "integration/mobile" }',
				`task: ${JSON.stringify(gatedTask(join(env.dir, "worktree-started"), gate, "WORKTREE_MOBILE_ANSWER"))}`,
				"Do not do anything else. Just call the subagent tool twice.",
			].join("\n"), { agentDir: process.env.PI_INTEGRATION_HERDR_AGENT_DIR, extraArgs: `-e ${shellQuote(teleportWrapper)} --session ${shellQuote(original)}` });
			await waitForFile(join(env.dir, "ordinary-started"));
			await waitForFile(join(env.dir, "worktree-started"));
			const binding = readSessionBinding(original)!;
			const worktreeNode = ownedNodes(original).find((node) => node.name === "worktree-mobile");
			const worktree = { path: worktreeNode?.cwd, workspaceId: worktreeNode?.workspaceId };
			assert.ok(worktree?.path && worktree.workspaceId);
			try {
				const fork = join(env.dir, "independent-fork.jsonl");
				const copied = entries(original);
				copied[0].id = "independent-fork";
				writeFileSync(fork, copied.map((row) => JSON.stringify(row)).join("\n") + "\n");
				const decoy = createTrackedSurface(env, "independent-fork");
				await waitForPaneReady(decoy);
				startPi(decoy, env.dir, "Return exactly DECOY_READY", { extraArgs: `--session ${shellQuote(fork)}` });
				await waitForScreen(decoy, /DECOY_READY/);
				runInPane(parent, `Call the teleport tool with EXACT parameters: action: "jump" target: "${destinationDir}"`);
				await waitUntil(() => parentSessionLocation(binding.storeDir, binding.sessionId)?.cwd === destinationDir, "Teleport must open the moved parent");
				await waitUntil(() => !existsSync(original), "Teleport must remove the original file");
				const firstMove = parentSessionLocation(binding.storeDir, binding.sessionId)!;
				assert.equal(entries(firstMove.sessionFile)[0].id, binding.sessionId);
				runInPane(firstMove.paneId!, 'Call the teleport tool with EXACT parameters: action: "back"');
				await waitUntil(() => parentSessionLocation(binding.storeDir, binding.sessionId)?.cwd === env.dir, "Teleport back must retain identity");
				const returned = parentSessionLocation(binding.storeDir, binding.sessionId)!;
				if (returned.workspaceId) env.workspaceIds.push(returned.workspaceId);
				writeFileSync(gate, "go");
				await waitUntil(() => results(returned.sessionFile).length === 2, `both results must reach returned parent: ${readPane(returned.paneId!, 250)}`, 30_000);
				assert.equal(new Set(results(returned.sessionFile).map((result) => result.details.deliveryId)).size, 2);
				assert.match(results(returned.sessionFile).map((result) => result.content).join("\n"), /ORDINARY_MOBILE_ANSWER/);
				assert.match(results(returned.sessionFile).map((result) => result.content).join("\n"), /WORKTREE_MOBILE_ANSWER/);
				assert.equal(results(fork).length, 0);
				assert.ok(existsSync(worktree.path), "completed worktree remains retained");
				const workspaces = JSON.parse(execFileSync("herdr", ["workspace", "list"], { encoding: "utf8" })).result.workspaces;
				assert.ok(workspaces.some((workspace: any) => workspace.workspace_id === worktree.workspaceId), "completed worktree workspace remains retained after parent moves");
				env.surfaces.push(returned.paneId!);
				runInPane(returned.paneId!, "/quit");
				await waitUntil(() => !existsSync(`/proc/${returned.pid}`), "returned Pi must exit");
			} finally {
				const root = sessionLineageRoots(binding.storeDir, binding.sessionId).find((dir) => reduceLineage(dir).nodes.has(worktreeNode!.nodeId))!;
				await waitUntil(() => { const location = childSessionLocation(root, worktreeNode!.nodeId); return !location || !sessionLocationAlive(location); }, "worktree child must finish its Pi shutdown", 20_000);
				execFileSync("herdr", ["worktree", "remove", "--workspace", worktree.workspaceId, "--force", "--trust-repository"], { encoding: "utf8" });
			}
		});
	});
}
