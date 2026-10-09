/**
 * Regression: a streaming parent must receive one copy of a child result.
 *
 * `pi.sendMessage(..., { deliverAs: "steer" })` queues the message until the
 * parent turn reaches a boundary. While the parent streams, waits for an
 * `ask_user` answer, or compacts, the parent session does not contain the
 * delivery id. The parent-side recovery route used to read that as a failed
 * delivery: it released the durable claim and queued the same result again on
 * the next tick. When the turn finally resumed, the parent saw one result many
 * times. One recorded incident delivered 78 copies of one review result.
 *
 * Frozen contract for the parent-side recovery route:
 *
 * - one delivery id is sent to the exact parent session at most once per
 *   process, even while the parent has not persisted it yet;
 * - a claim that another observer holds for a queued copy is not a delivery
 *   failure, so it is never projected as `delivery-failed`;
 * - the durable acknowledgement is published only after the parent session
 *   really holds the result.
 */
import assert from "node:assert/strict";
import { seedSessionBinding } from "../pi-extension/subagents/session-binding.ts";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import subagentsExtension, { __test__ } from "../pi-extension/subagents/index.ts";
import { createLifecycle } from "../pi-extension/subagents/lifecycle.ts";
import { consumeRecoveryAttempt } from "../pi-extension/subagents/watchdog.ts";
import {
	appendLineageEvent,
	appendLineageInbox,
	claimLineageInboxMaterialization,
	isLineageInboxMaterialized,
	registerLineage,
} from "../pi-extension/subagents/lineage.ts";
import {
	cleanupTempDirs,
	readJsonLines,
	tempDir,
	writeSessionFile,
} from "./delivery-seam-support.ts";

const PARENT_SESSION_ID = "parent-session";
const CHILD_ID = "proof-child";
const DELIVERY_ID = `terminal:${CHILD_ID}`;
const RESULT = "Subagent reviewer completed.\n\ncaptured review";

interface ParentHarness {
	ctx: any;
	sends: any[];
	widgets: any[];
}

/** Install the real extension against a parent that only queues sends. */
function installParentHarness(
	sessionsDir: string,
	parentSessionFile: string,
): ParentHarness {
	seedSessionBinding(parentSessionFile, { version: 1, storeDir: join(sessionsDir, "bindings") });
	const widgets: any[] = [];
	const sends: any[] = [];
	const handlers = new Map<string, (...args: any[]) => unknown>();
	const pi: any = {
		events: {},
		on(event: string, handler: (...args: any[]) => unknown) {
			handlers.set(event, handler);
		},
		registerTool() {},
		registerCommand() {},
		registerMessageRenderer() {},
		registerShortcut() {},
		getAllTools: () => [],
		sendUserMessage() {},
		sendMessage(message: any) {
			sends.push(message);
		},
	};
	subagentsExtension(pi);
	const ctx: any = {
		cwd: sessionsDir,
		hasUI: true,
		sessionManager: {
			getSessionId: () => PARENT_SESSION_ID,
			getSessionFile: () => parentSessionFile,
			getSessionDir: () => sessionsDir,
		},
		modelRegistry: {
			getAll: () => [],
			getAvailable: () => [],
			find: () => undefined,
			hasConfiguredAuth: () => false,
		},
		ui: {
			setWidget(_name: string, widget: unknown) {
				if (typeof widget === "function") widgets.push(widget({}, {}));
			},
			notify() {},
		},
	};
	__test__.runningSubagents.clear();
	// A real session start: it installs the live parent context used to decide
	// whether this session may materialize the delivery.
	handlers.get("session_start")?.({}, ctx);
	return { ctx, sends, widgets };
}

/** Publish one terminal inbox for the exact parent session, as a child does. */
function publishQueuedResult(options: {
	sessionsDir: string;
	parentSessionFile: string;
}): string {
	const lineage = registerLineage({
		artifactDir: join(options.sessionsDir, "artifacts", PARENT_SESSION_ID),
		nodeId: CHILD_ID,
		parentSessionId: PARENT_SESSION_ID,
		parentSessionFile: options.parentSessionFile,
		launchKind: "fresh",
	});
	appendLineageEvent(lineage.rootDir, DELIVERY_ID, "terminal", CHILD_ID, {
		outcome: "terminal",
		resultContent: RESULT,
	});
	appendLineageInbox(
		lineage.rootDir,
		CHILD_ID,
		DELIVERY_ID,
		{ sessionId: PARENT_SESSION_ID, sessionFile: options.parentSessionFile },
		{ kind: "terminal", resultContent: RESULT, status: "completed" },
	);
	return lineage.rootDir;
}

/** Append the parent-side durable record of one delivered message. */
function persistDeliveredResult(parentSessionFile: string): void {
	const record = {
		type: "custom_message",
		customType: "subagent_result",
		content: RESULT,
		display: true,
		details: { kind: "terminal", childId: CHILD_ID, deliveryId: DELIVERY_ID },
	};
	writeFileSync(
		parentSessionFile,
		`${readFileSync(parentSessionFile, "utf8")}${JSON.stringify(record)}\n`,
		"utf8",
	);
}

/** Await queued work and one timer turn. */
async function tick(): Promise<void> {
	await new Promise<void>((resolve) => setTimeout(resolve, 0));
}

after(cleanupTempDirs);

describe("one queued result stays one queued result", () => {
	it("queues one copy while the parent has not persisted the result yet", async () => {
		const sessionsDir = tempDir("pi-delivery-storm-");
		const parentSessionFile = writeSessionFile(join(sessionsDir, "parent.jsonl"), {
			id: PARENT_SESSION_ID,
			cwd: sessionsDir,
		});
		// Install first so the session start cannot deliver a fixture that does
		// not exist yet; every send in this test is an explicit recovery pass.
		const harness = installParentHarness(sessionsDir, parentSessionFile);
		const rootDir = publishQueuedResult({ sessionsDir, parentSessionFile });

		await __test__.restorePendingLineageInboxes(harness.ctx);
		assert.equal(harness.sends.length, 1, "the first recovery pass queues the result once");

		// The parent is still streaming, so the steer is only queued.
		await __test__.restorePendingLineageInboxes(harness.ctx);
		assert.equal(
			harness.sends.length,
			1,
			"a second recovery pass must not queue a second copy of the same result",
		);
		assert.equal(
			isLineageInboxMaterialized(rootDir, DELIVERY_ID),
			false,
			"a queued copy is not a durable parent record",
		);

		persistDeliveredResult(parentSessionFile);
		await __test__.restorePendingLineageInboxes(harness.ctx);
		assert.equal(harness.sends.length, 1, "the durable parent record causes no new copy");
		assert.equal(
			isLineageInboxMaterialized(rootDir, DELIVERY_ID),
			true,
			"the queued copy is acknowledged once the parent session holds it",
		);
	});

	it("does not treat a delivery ID quoted in a user message as a saved result", async () => {
		const sessionsDir = tempDir("pi-delivery-quoted-id-");
		const parentSessionFile = writeSessionFile(join(sessionsDir, "parent.jsonl"), { id: PARENT_SESSION_ID, cwd: sessionsDir });
		const harness = installParentHarness(sessionsDir, parentSessionFile);
		const rootDir = publishQueuedResult({ sessionsDir, parentSessionFile });
		writeFileSync(parentSessionFile, JSON.stringify({ type: "message", message: { role: "user", content: DELIVERY_ID } }) + "\n", { flag: "a" });
		await __test__.restorePendingLineageInboxes(harness.ctx);
		assert.equal(harness.sends.length, 1);
		assert.equal(isLineageInboxMaterialized(rootDir, DELIVERY_ID), false);
	});
	it("does not project another observer's queued copy as a delivery failure", async () => {
		const sessionsDir = tempDir("pi-delivery-busy-");
		const parentSessionFile = writeSessionFile(join(sessionsDir, "parent.jsonl"), {
			id: PARENT_SESSION_ID,
			cwd: sessionsDir,
		});
		installParentHarness(sessionsDir, parentSessionFile);
		const rootDir = publishQueuedResult({ sessionsDir, parentSessionFile });

		// Another observer in this process queued the copy and still holds the
		// claim while the parent streams.
		const claim = claimLineageInboxMaterialization({
			rootDir,
			deliveryId: DELIVERY_ID,
			nodeId: CHILD_ID,
			hasExactSessionEvidence: () => false,
			processIdentity: { pid: process.pid },
		});
		assert.equal(claim.status, "acquired", "the fixture observer owns the queued copy");

		const sessionFile = join(sessionsDir, `${CHILD_ID}.jsonl`);
		writeSessionFile(sessionFile, { id: CHILD_ID, cwd: sessionsDir });
		const running: any = {
			id: CHILD_ID,
			name: "reviewer",
			task: "review",
			surface: "pane-1",
			startTime: Date.now(),
			sessionFile,
			interactive: false,
			runtimePlan: undefined,
			lifecycle: createLifecycle(Date.now()),
			lineage: {
				rootDir,
				rootId: "root",
				nodeId: CHILD_ID,
				parentSessionId: PARENT_SESSION_ID,
				parentSessionFile,
				launchKind: "fresh",
			},
			pendingTerminalDelivery: {
				finalAssistant: undefined,
				resultContent: RESULT,
				status: "completed",
				queued: false,
				finalize: () => {
					throw new Error("the queued copy must not be sent again");
				},
			},
		};
		__test__.runningSubagents.set(CHILD_ID, running);

		for (let turn = 0; turn < 5; turn += 1) {
			__test__.observeRunningSubagent(running, Date.now());
			await tick();
		}

		const logPath = join(sessionsDir, "subagent-delivery.log");
		const failures = existsSync(logPath)
			? readJsonLines(logPath).filter((record) =>
					/fail|error/i.test(`${record.event} ${record.error ?? ""}`),
				)
			: [];
		assert.deepEqual(
			failures,
			[],
			`a claim held for a queued copy is not a delivery failure, saw ${JSON.stringify(failures)}`,
		);
		const widgetText = (__test__.renderSubagentWidgetLines as any)([running], 100).join("\n");
		assert.ok(
			!widgetText.includes("delivery-failed"),
			`a queued copy must not project a delivery failure row, saw ${widgetText}`,
		);
	});
});

describe("a finished child leaves the widget", () => {
	it("hides a delivered row while its surface cleanup is still pending", () => {
		const running: any = {
			id: "retired-child",
			name: "reviewer",
			task: "review",
			surface: "pane-1",
			startTime: Date.now(),
			sessionFile: "/tmp/retired-child.jsonl",
			interactive: false,
			runtimePlan: undefined,
			lifecycle: createLifecycle(Date.now()),
			retired: true,
			cleanupPending: true,
		};
		assert.deepEqual(
			(__test__.renderSubagentWidgetLines as any)([running], 100),
			[],
			"a delivered child must not keep a row while Herdr closes its pane",
		);
	});

	it("does not kill the pane again once the recovery budget is exhausted", async () => {
		const sessionsDir = tempDir("pi-recovery-exhausted-");
		const parentSessionFile = writeSessionFile(join(sessionsDir, "parent.jsonl"), {
			id: PARENT_SESSION_ID,
			cwd: sessionsDir,
		});
		const rootDir = publishQueuedResult({ sessionsDir, parentSessionFile });
		const recoveryLog = join(rootDir, "subagent-delivery.log");
		for (const cause of ["crash", "stale", "stale"] as const) {
			consumeRecoveryAttempt({ logPath: recoveryLog, childId: CHILD_ID, cause });
		}

		const running: any = {
			id: CHILD_ID,
			name: "reviewer",
			task: "review",
			surface: "pane-that-must-not-be-closed",
			startTime: Date.now(),
			sessionFile: join(sessionsDir, `${CHILD_ID}.jsonl`),
			interactive: false,
			runtimePlan: undefined,
			lifecycle: createLifecycle(Date.now()),
			lineage: {
				rootDir,
				rootId: "root",
				nodeId: CHILD_ID,
				parentSessionId: PARENT_SESSION_ID,
				parentSessionFile,
				launchKind: "fresh",
			},
		};

		const result = await (__test__.attemptRecovery as any)(running, "stale");

		assert.deepEqual(result, {
			recovered: false,
			exhausted: true,
			reason: "Recovery failed after mixed crash and stale attempts.",
		});
		assert.equal(running.recoveryExhausted, true, "the spent budget is final for this child");
		assert.equal(running.recoveryState?.label, "recovery failed (3/3)");
		assert.deepEqual(
			readJsonLines(recoveryLog).filter((record) => record.event === "recovery-kill"),
			[],
			"an exhausted budget must not touch the pane again",
		);
	});
});
