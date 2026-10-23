import type {
	AgentToolResult,
	ExtensionAPI,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { keyHint } from "@earendil-works/pi-coding-agent";
import { Type, type Static } from "@sinclair/typebox";
import {
	Box,
	Text,
	truncateToWidth,
	visibleWidth,
} from "@earendil-works/pi-tui";
import { dirname, join } from "node:path";
import {
	readFileSync,
	writeFileSync,
	existsSync,
	rmSync,

	readdirSync,
} from "node:fs";
import {
	isTerminalAvailable,
	closePane,
	rememberPaneTab,
	interruptPane,
	readPaneAsync,
	inspectPane,
	getPaneProcessInfo,
	waitForPaneAbsence,
	waitForProcessesExit,
} from "./terminal.ts";
import { acknowledgeExitSidecar, acknowledgePingSidecar, waitForCompletion } from "./completion.ts";
import { materializeResultFile } from "./delivery-files.ts";
import { frameDeliveryPayload, type DeliveryStatus } from "./delivery-payload.ts";
import subagentLifecycle, { hasChildLifecycle } from "./subagent-done.ts";
import { registerReplicateTool, replicationName, replicationAssignment, replicationExtensionArgs, replicationContextMessages } from "./replication.ts";
import { snapshotSource } from "./source-state.ts";
import { linkedOutputDetails, readExecutionOwner, trackExecutionOwners, type ExecutionOwner } from "./execution-owner.ts";
import { runReplicaBackground } from "./replica-background.ts";
import { reserveReplicaBranch } from "./replica-branch.ts";
import { getHerdrCurrentPaneTitle } from "./herdr.ts";
import { replicaWorkFile, createReplicaWork, readReplicaWork, saveReplicaRuntime, failReplicaLaunch, captureReplicaWorkLocation, type ReplicaCompletion } from "./replica-work.ts";
import { bindSessionRuntime, beginChildSessionMove, readSessionBinding, childSessionLocation, parentSessionLocation, sessionBindingStore, sessionOwnsPane, sessionLocationAlive, sessionServerAlive } from "./session-binding.ts";

import { waitForDeliveryDrain } from "./delivery-drain.ts";
import { createDeliveryLog } from "./delivery-log.ts";

import {
	classifyStaleness,
	consumeRecoveryAttempt,
	resolveQuietThreshold,
	shouldStartStaleRecovery,
	type RecoveryCause,
} from "./watchdog.ts";
import {
	resolveRuntimePlan,
	wrapPiModelRegistry,
	type ResolvedRuntimePlan,
	type ThinkingLevel,
} from "./runtime-routing.ts";
import {
	discoverAgentCatalog,
	resolveDenyTools,
	type AgentDefinition,
	type ListedAgentDefinition,
} from "./role-catalog.ts";
type AgentDefaults = AgentDefinition;
type SubagentSessionMode = "standalone" | "lineage-only" | "fork";
function getAgentConfigDir(): string { return process.env.PI_CODING_AGENT_DIR ?? join(process.env.HOME ?? "", ".pi", "agent"); }

import {
	findLastAssistantMessage,
	findObservedSessionRuntime,
	getNewEntries,
	readEntriesAfterBaseline,
	findNewestAppendedAssistant,

	captureSessionBaseline,
} from "./session.ts";
import {
	type SubagentStatusState,
	formatElapsedDuration,
	loadStatusConfig,
} from "./status.ts";
import {
	readSubagentActivityFile,
  readSubagentSettledEventsFile,
  orderSettledActivityEvents,
	type ActivityReadResult,
	type SettledActivityEvent,
	type SubagentActivityState,
} from "./activity.ts";
import {
	createLifecycle,
	markCompleted,
	markCompletionDetected,
	consumeInterruptBoundary,
	markDelivery,
	markFailed,
	markInterruptRequested,
	markProcessRunning,
	observeActivity,
	observePaneInspection,
	projectLifecycle,
	type LifecycleProjection,
	type SubagentLifecycle,
	type PaneInspection,
} from "./lifecycle.ts";
import {
	createResultDeliveryQueue,
  enqueueResultDelivery,
	type ResultDeliveryQueue,
} from "./result-delivery-queue.ts";
import {
	type NewestAssistantEntry,
	type SettledDeliveryIdentity,
	type SessionBaselineCursor,
} from "./settled-contract.ts";
import {
  appendLineageEvent,
  appendLineageInbox,
  claimLineageInboxMaterialization,
  completeLineageInboxMaterialization,
  releaseLineageInboxMaterialization,
  hasLineageEvent,
  discoverLineageRoots,
  hasUndrainedDescendants,
  latestDescendantDeliveryAt,
  lineageIntegrityError,
  pendingLineageInboxes,
  reduceLineage,
  type LineageRegistration,
  type LineageNodeState,
} from "./lineage.ts";
import {
	captureWorktreeHandoff,
	launchPiSubagent,
	persistWorktreeResult,
	runSubagentScript,
	writeWorktreeManifest,
	buildSubagentToolAllowlist,
	type WorktreeHandoff,
	type WorktreeLaunch,
} from "./launch.ts";


// Survive /reload: replace presentation timers while keeping active completion
// watchers and their registry alive. Old module closures continue watching the
// children; the reloaded module adopts the shared registry for status/interrupts.
const WIDGET_INTERVAL_KEY = Symbol.for("pi-subagents/widget-interval");
const STATUS_INTERVAL_KEY = Symbol.for("pi-subagents/status-interval");
const RUNTIME_KEY = Symbol.for("pi-subagents/runtime");





{
	const prevInterval = (globalThis as any)[WIDGET_INTERVAL_KEY];
	if (prevInterval) {
		clearInterval(prevInterval);
		(globalThis as any)[WIDGET_INTERVAL_KEY] = null;
	}
	const prevStatusInterval = (globalThis as any)[STATUS_INTERVAL_KEY];
	if (prevStatusInterval) {
		clearInterval(prevStatusInterval);
		(globalThis as any)[STATUS_INTERVAL_KEY] = null;
	}
}




const SubagentParams = Type.Object({
	name: Type.String({
		description:
			"Short stable label for the subagent; for a new coordinated group use <task>-<role>[-n] (shown in the widget and pane title)",
	}),
	task: Type.String({ description: "Task/prompt for the sub-agent" }),
	agent: Type.Optional(
		Type.String({
			description:
				"Agent name to load defaults from. Discovery precedence is project .pi/agents, global ~/.pi/agent/agents, then installed role packs.",
		}),
	),
	systemPrompt: Type.Optional(
		Type.String({
			description:
				"Role/system-prompt text for a bare spawn. Named agents keep their definition body.",
		}),
	),
	skills: Type.Optional(
		Type.String({
			description: "Comma-separated skills (overrides agent default)",
		}),
	),
	tools: Type.Optional(
		Type.String({
			description: "Comma-separated tools (overrides agent default)",
		}),
	),
	cwd: Type.Optional(
		Type.String({
			description:
				"Working directory for the sub-agent. Without worktree, the agent starts in this folder. With worktree, this selects the source Git repository and the agent starts at the created worktree root.",
		}),
	),
	worktree: Type.Optional(
		Type.Object({
			branch: Type.String({
				minLength: 1,
        description:
          "New branch name for an isolated Herdr-managed Git worktree",
			}),
			base: Type.Optional(
				Type.String({
					description:
						"Git revision to branch from. Defaults to the source checkout's committed HEAD.",
				}),
			),
		}),
	),
	fork: Type.Optional(
		Type.Boolean({
			description:
				"Force the full-context fork mode for this spawn. The sub-agent inherits the current session conversation, overriding any agent frontmatter session-mode.",
		}),
	),
	interactive: Type.Optional(
		Type.Boolean({
			description:
				"Mark the subagent as interactive (long-running, user drives the conversation in its own pane). When true, the main session is not woken by status transitions (stalled/recovered) for this subagent. If omitted, falls back to the agent's `interactive` frontmatter, otherwise the inverse of `auto-exit` (agents that auto-exit are autonomous and get stall pings; agents that don't are interactive and stay quiet).",
		}),
	),
});




function discoverAgentDefinitions(
	pi?: Pick<ExtensionAPI, "events">,
): ListedAgentDefinition[] {
	return discoverAgentCatalog(pi).agents;
}







function resolveEffectiveSessionMode(
	params: Static<typeof SubagentParams>,
	agentDefs: AgentDefaults | null,
): SubagentSessionMode {
	if (params.fork) return "fork";
	return agentDefs?.sessionMode ?? "standalone";
}

function resolveLaunchBehavior(
	params: Static<typeof SubagentParams>,
	agentDefs: AgentDefaults | null,
): {
	sessionMode: SubagentSessionMode;
	seededSessionMode: "lineage-only" | "fork" | null;
	inheritsConversationContext: boolean;
	taskDelivery: "direct" | "artifact";
} {
	const sessionMode = resolveEffectiveSessionMode(params, agentDefs);
	const inheritsConversationContext = sessionMode === "fork";
	return {
		sessionMode,
		seededSessionMode: sessionMode === "standalone" ? null : sessionMode,
		inheritsConversationContext,
		taskDelivery: inheritsConversationContext ? "direct" : "artifact",
	};
}

/**
 * Decide whether a subagent is interactive (user-driven, long-running).
 *
 * Resolution order:
 *   1. Explicit `interactive` tool parameter wins.
 *   2. Explicit `interactive` frontmatter field on the agent.
 *   3. Default: the inverse of `auto-exit`. Agents that auto-exit are
 *      autonomous (scout, worker, reviewer) and the parent session should be
 *      woken on stall/recovery transitions. Agents that don't auto-exit are
 *      driven by the user in their own pane and stall pings are noise.
 *
 * An internal bare launch has no role defaults and runs autonomously
 * unless the caller explicitly sets `interactive: true`.
 */
function resolveEffectiveAutoExit(
	params: Static<typeof SubagentParams>,
	agentDefs: AgentDefaults | null,
): boolean {
	// Named agents preserve their declared behavior. Internal bare calls are
	// autonomous by default, including full-context forks: `fork` controls
	// context inheritance, not whether the child should remain open.
	// Interactive callers opt out explicitly with `interactive: true`.
	if (agentDefs) return agentDefs.autoExit ?? false;
	return params.interactive !== true;
}

function resolveEffectiveInteractive(
	params: Static<typeof SubagentParams>,
	agentDefs: AgentDefaults | null,
): boolean {
	if (params.interactive != null) return params.interactive;
	if (agentDefs?.interactive != null) return agentDefs.interactive;
	return !resolveEffectiveAutoExit(params, agentDefs);
}

function loadAgentDefaults(
	agentName: string,
	pi?: Pick<ExtensionAPI, "events">,
): ListedAgentDefinition | null {
	return (
		discoverAgentCatalog(pi).agents.find((agent) => agent.name === agentName) ??
		null
	);
}


/** Return whether an agent must be prevented from launching its own role. */
function isSelfSpawnBlocked(
	targetAgent: string | undefined,
	currentAgent: string | undefined,
	currentAgentDefaults: AgentDefaults | null,
): boolean {
	return Boolean(
		targetAgent &&
			currentAgent &&
			targetAgent === currentAgent &&
			currentAgentDefaults?.allowSelfSpawn !== true,
	);
}

function formatElapsed(seconds: number): string {
	if (seconds < 60) return `${seconds}s`;
	const m = Math.floor(seconds / 60);
	const s = seconds % 60;
	return `${m}m ${s}s`;
}



function shouldRetainSubagentSurface(
	running: Pick<RunningSubagent, "worktree"> | { worktree?: unknown },
): boolean {
	return !!running.worktree;
}

function finalizeSubagentSurface(
	running: RunningSubagent,
	state: "ready_for_review" | "failed" | "needs_help",
	ignoreCloseError = false,
	closeOrdinaryPane = true,
): WorktreeHandoff | undefined {
	if (running.worktree) {
		let handoff = captureWorktreeHandoff(running.worktree);
		try {
			persistWorktreeResult(running.worktree, state, handoff);
		} catch (error: any) {
			handoff = {
				...handoff,
				gitError: [
					handoff.gitError,
					`Manifest update failed: ${error?.message ?? String(error)}`,
				]
					.filter(Boolean)
					.join("; "),
			};
		}
		return handoff;
	}

	if (!closeOrdinaryPane || running.lineage?.launchKind === "worktree" || !childPaneOwned(running)) return undefined;
	try {
		closePane(running.surface);
	} catch (error) {
		if (!ignoreCloseError) throw error;
	}
	return undefined;
}

const statusConfig = loadStatusConfig();

const quietThresholdMs = resolveQuietThreshold(
	process.env.PI_SUBAGENT_QUIET_THRESHOLD_MS,
	statusConfig.quietThresholdMs,
);


function recoveryLogPath(running: Pick<RunningSubagent, "lineage" | "sessionFile">): string {
	return join(running.lineage?.rootDir ?? dirname(running.sessionFile), "subagent-delivery.log");
}

function recoveryDeliveryLog(running: Pick<RunningSubagent, "lineage" | "sessionFile">) {
	return createDeliveryLog({ logPath: recoveryLogPath(running) });
}

const RESULT_CONTINUATION_PROMPT =
	"Parent action: Continue the parent task using this result; do not return an empty response.";

function boundResultPresentation(body: string, sessionRef: string): string {
	return body + sessionRef;
}

function formatSessionReference(sessionFile?: string): string {
	return sessionFile
		? `\n\nSession: ${sessionFile}\nResume: pi --session ${sessionFile}`
		: "";
}

function resolveUnexpectedErrorPresentation(
	prefix: string,
	error: unknown,
	sessionFile?: string,
): string {
	const message = error instanceof Error ? error.message : String(error);
	return boundResultPresentation(
		`${prefix}: ${message}`,
		formatSessionReference(sessionFile),
	);
}

function sendSubagentResult(
	api: Pick<ExtensionAPI, "sendMessage">,
	content: string,
	details: Record<string, unknown>,
): void {
	const childId = typeof details.childId === "string" ? details.childId : undefined;
	const running = childId ? runningSubagents.get(childId) : undefined;
	// A replay must keep its saved payload, file and owner together.
	const savedDelivery = Object.hasOwn(details, "executionOwner");
	const executionOwner = savedDelivery
		? readExecutionOwner(details.executionOwner)
		: running?.executionOwner;
	const resultContent = (savedDelivery ? undefined : running?.deliveryPayload) ??
		(typeof details.resultContent === "string"
			? details.resultContent
			: boundResultPresentation(content, ""));
	if (details.replication && runtime.latestCtx) {
		details = { ...details, receiverSessionId: runtime.latestCtx.sessionManager.getSessionId() };
	}
	const promptContent = details.replication ? resultContent : boundResultPresentation(
		`${resultContent}\n\n${RESULT_CONTINUATION_PROMPT}`,
		"",
	);
	api.sendMessage(
		{
			customType: "subagent_result",
			content: promptContent,
			display: true,
			details: {
				...details,
				...linkedOutputDetails(executionOwner),
				resultContent,
				...(!savedDelivery && running?.resultPath ? { resultPath: running.resultPath } : {}),
			},
		},
		{ triggerTurn: true, deliverAs: "steer" },
	);
}

function formatWorktreeHandoff(worktree: WorktreeHandoff): string {
	const state = worktree.gitError
		? "inspection unknown"
		: worktree.conflicted
			? "conflicted"
			: worktree.clean
				? "clean"
				: "dirty";
	const ahead =
		worktree.commitsAhead == null
			? "commits ahead unknown"
			: `${worktree.commitsAhead} commit${worktree.commitsAhead === 1 ? "" : "s"} ahead`;
	const lines = [
		"Worktree result retained for review:",
		`Worktree: ${worktree.path}`,
		`Workspace: ${worktree.workspaceId}`,
		`Branch: ${worktree.branch}`,
		`Base/head: ${worktree.baseSha} -> ${worktree.headSha ?? "unknown"}`,
		`State: ${state} · ${ahead}`,
	];
	if (worktree.changedFiles?.length)
		lines.push(`Changed: ${worktree.changedFiles.join(", ")}`);
	if (worktree.untrackedFiles?.length)
		lines.push(`Untracked: ${worktree.untrackedFiles.join(", ")}`);
	if (worktree.gitError)
		lines.push(`Git inspection warning: ${worktree.gitError}`);
	lines.push(
		"After review and preservation, remove the workspace with:",
		`  herdr worktree remove --workspace ${worktree.workspaceId}`,
	);
	return lines.join("\n");
}

function resolveResultPresentation(
	result: Pick<
		SubagentResult,
		| "exitCode"
		| "elapsed"
		| "summary"
		| "sessionFile"
		| "errorMessage"
		| "fallbackAttempts"
		| "worktree"
		| "resultPath"
	>,
	name: string,
	runtimeMismatch?: string,
): string {
	const resultRef = result.resultPath ? `\n\nResult file: ${result.resultPath}` : "";
	const sessionRef = resultRef + formatSessionReference(result.sessionFile);
	let body: string;

	if (result.errorMessage) {
		// Auto-retry exhausted or other agent-loop error. The subagent did not
		// produce a usable result — surface the underlying provider/network
		// failure so the orchestrator can decide whether to retry, resume, or
		// change approach instead of silently treating the run as completed.
		body =
			`Sub-agent "${name}" failed after ${formatElapsed(result.elapsed)} ` +
			`(provider/agent error — auto-retry exhausted).\n\n` +
			`Error: ${result.errorMessage}\n\n` +
			`The subagent did not produce a result. You can retry by spawning a new ` +
			`subagent or resume the session with subagent_resume.`;
	} else {
		body =
			result.exitCode === 0
				? `Sub-agent "${name}" completed (${formatElapsed(result.elapsed)}).\n\n${result.summary}`
				: `Sub-agent "${name}" failed (exit code ${result.exitCode}).\n\n${result.summary}`;
	}

	if (result.fallbackAttempts && result.fallbackAttempts.length > 1) {
		body += `\n\nModels attempted: ${result.fallbackAttempts.join(", ")}`;
	}
	if (result.worktree) body += `\n\n${formatWorktreeHandoff(result.worktree)}`;
	const runtimeWarning = runtimeMismatch
		? `\n\nRuntime warning: ${runtimeMismatch}`
		: "";
	return boundResultPresentation(body, sessionRef + runtimeWarning);
}

/**
 * Result from running a single subagent.
 */
interface SubagentResult {
	name: string;
	task: string;
	summary: string;
	sessionFile?: string;

	resultPath?: string;

	supervisionEpoch?: number;
	recoveryFailed?: boolean;

	/** The user closed the owned Herdr tab, so recovery is forbidden. */
	cancelledByUser?: boolean;

	closeWithAnswer?: boolean;
	exitCode: number;
	elapsed: number;
	error?: string;
	/** Provider/agent error message when auto-retry exhausted (overload, rate limit, etc.). */
	errorMessage?: string;
	/** Ordered models launched for this run, including failed fallback attempts. */
	fallbackAttempts?: string[];
	ping?: { name: string; message: string };
	worktree?: WorktreeHandoff;
	/** Confirmed manual or external Herdr pane closure. */
	paneDisappeared?: true;
}

interface PendingTerminalDelivery {
  finalAssistant?: SettledDeliveryIdentity;
  resultContent?: string;

  status?: DeliveryStatus;
  queued: boolean;
  finalize: () => void | Promise<void>;
}

/**
 * State for a launched (but not yet completed) subagent.
 */
interface RunningSubagent {
	executionOwner?: ExecutionOwner;
	/** Current-session replica, not a named-role launch. */
	replication?: boolean;
	replicaWorkFile?: string;
	/** Settled task waiting for its exact parent before integration. */
	pendingReplicaResult?: ReplicaCompletion;
	/** In-flight background work must not be resubmitted by status ticks or reload. */
	replicaFinishing?: boolean;
	replicaRetryAt?: number;
	replicaCleaning?: boolean;
	lineage?: LineageRegistration;
	id: string;
	name: string;
	task: string;
	agent?: string;
	surface: string;
	startTime: number;
	tabId?: string;
	sessionFile: string;
	launchScriptFile?: string;
	activityFile?: string;
  settledEventsFile?: string;
	activity?: SubagentActivityState;
	sessionBaseline?: SessionBaselineCursor;
	activityRead?: {
		ok: boolean;
		reason?: "missing" | "invalid" | "wrong-id";
		error?: string;
	};
	abortController?: AbortController;
	/**
	 * Optional legacy status snapshot retained only for hydrating pre-lifecycle
	 * runtime entries after /reload. Live observation uses `lifecycle` only.
	 */
	statusState?: SubagentStatusState;
	lifecycle: SubagentLifecycle;
	/** Last projected kind used to detect stalled/recovered transitions. */
	lastProjectedKind?: LifecycleProjection["kind"];
	/** User-driven sessions are observed but never killed or resumed by the watchdog. */
	interactive: boolean;
	/** Parent-resolved model/thinking selection and provenance. */
	runtimePlan: ResolvedRuntimePlan | undefined;
  /** Pending terminal parent enqueue; retained until sendMessage succeeds. */
  pendingTerminalDelivery?: PendingTerminalDelivery;

  /** Latest attributable durable delivery failure shown in the widget. */
  deliveryFailure?: { deliveryId: string; error: string };

  resultPath?: string;
  deliveryPayload?: string;

  supervisionEpoch?: number;
  recoveryAttempt?: Promise<void>;

  ignorePriorSentinelEpoch?: number;
  recoveryState?: { cause: RecoveryCause; attempt: number; label: string };
  recoveryFailureReason?: string;
  /** The recovery budget is spent; the watchdog must not recover this child again. */
  recoveryExhausted?: boolean;
  cleanupPending?: boolean;
  cleanupAttempts?: number;
  cleanupRetryAt?: number;
  /** Delivered and finished: the row leaves the widget while the pane is cleaned up. */
  retired?: boolean;
  cancellationAttempt?: Promise<boolean>;
	worktree?: WorktreeLaunch;

	recoveryWorkspace?: { id: string; cwd: string };
}

/**
 * One result this process already queued for the parent but has not seen the
 * parent session persist yet. The durable claim stays ours while the copy is
 * only queued, so no observer can queue a second copy of the same result.
 */
interface InflightDelivery {
	rootDir: string;
	nodeId: string;
	token: string;
}

interface SubagentRuntime {
	resolveExecutionOwner?: (id: string) => ExecutionOwner | undefined;
	runningSubagents: Map<string, RunningSubagent>;
	resultDeliveryQueue: ResultDeliveryQueue;
	inflightDeliveries: Map<string, InflightDelivery>;
	pi?: ExtensionAPI;
	latestCtx?: ExtensionContext;
	/** Do not queue into a source session after Teleport takes its snapshot. */
	handoffPending?: boolean;
}

function createSubagentRuntime(): SubagentRuntime {
	return {
		runningSubagents: new Map<string, RunningSubagent>(),
		resultDeliveryQueue: createResultDeliveryQueue(),
		inflightDeliveries: new Map<string, InflightDelivery>(),
	};
}

/** Runtime state preserved across /reload. */
const runtime: SubagentRuntime =
	(globalThis as any)[RUNTIME_KEY] ??
	((globalThis as any)[RUNTIME_KEY] = createSubagentRuntime());
if (!runtime.resultDeliveryQueue) {
	runtime.resultDeliveryQueue = createResultDeliveryQueue();
}
if (!runtime.inflightDeliveries) {
	runtime.inflightDeliveries = new Map<string, InflightDelivery>();
}
const runningSubagents = runtime.runningSubagents;


function recordDeliveryFailure(
  running: RunningSubagent,
  deliveryId: string,
  error: unknown,
  phase: string,
): void {
  const message = error instanceof Error ? error.message : String(error);
  createDeliveryLog({ logPath: join(dirname(running.sessionFile), "subagent-delivery.log") }).record(
    "delivery-failed",
    {
      childId: running.id,
      deliveryId,
      phase,
      error: message,
    },
  );
  running.deliveryFailure = { deliveryId, error: message };
  updateWidget();
}


/**
 * Publish the durable acknowledgement for one restored inbox and drop its
 * in-process record. A copy that was queued for the parent also waits until the
 * parent session holds it; until then the claim stays ours, because the copy is
 * only queued inside Pi and nobody may queue a second one for the same result.
 */
function acknowledgeRestoredInboxDelivery(input: {
	rootDir: string;
	nodeId: string;
	deliveryId: string;
	token: string;
	sessionFile: string;
	/** Set for a sent copy: the acknowledgement waits for the parent record. */
	requiresParentRecord?: boolean;
	settledActivitySequence?: number;
}): void {
	if (input.requiresParentRecord && !sessionContainsDelivery(input.sessionFile, input.deliveryId)) return;
	if (!completeLineageInboxMaterialization(input.rootDir, input.deliveryId, input.nodeId, input.token)) return;
	runtime.inflightDeliveries.delete(input.deliveryId);
	if (input.settledActivitySequence !== undefined) {
		appendLineageEvent(
			input.rootDir,
			`settled-delivered:${input.nodeId}:${input.settledActivitySequence}`,
			"settled_delivered",
			input.nodeId,
			{ resultId: input.deliveryId, activitySequence: input.settledActivitySequence },
		);
	}
}

/** Materialize inbox records left by a crash into this exact session once. */
async function restorePendingLineageInboxes(ctx: ExtensionContext): Promise<void> {
	if (runtime.handoffPending) return;
	const manager = ctx.sessionManager;
	if (
		!manager ||
		typeof manager.getSessionId !== "function" ||
		typeof manager.getSessionFile !== "function" ||
		typeof manager.getSessionDir !== "function"
	) return;
	const sessionId = manager.getSessionId();
	const sessionFile = manager.getSessionFile();
	if (!sessionFile) return;
	if (!runtime.pi) return;
	const roots = discoverLineageRoots(manager.getSessionDir(), sessionFile);
	for (const rootDir of roots) {
		for (const inbox of pendingLineageInboxes(rootDir, sessionId, sessionFile)) {
			const resultContent = inbox.payload.resultContent;
			if (typeof resultContent !== "string") continue;
			const kind = inbox.payload.kind ?? "terminal";
			const activitySequence = typeof inbox.payload.activitySequence === "number"
				? inbox.payload.activitySequence
				: undefined;

			// This process already queued this exact result. The parent has not
			// persisted it yet, so just finish the record when it does. Sending
			// again here is what delivered one result many times.
			const inflight = runtime.inflightDeliveries.get(inbox.deliveryId);
			if (inflight) {
				acknowledgeRestoredInboxDelivery({
					rootDir,
					nodeId: inbox.nodeId,
					deliveryId: inbox.deliveryId,
					token: inflight.token,
					sessionFile,
					requiresParentRecord: true,
					settledActivitySequence: activitySequence,
				});
				continue;
			}

			const claim = claimLineageInboxMaterialization({
				rootDir,
				deliveryId: inbox.deliveryId,
				nodeId: inbox.nodeId,
				hasExactSessionEvidence: () => sessionContainsDelivery(sessionFile, inbox.deliveryId),
			});
			// Another observer owns this delivery, or it is already acknowledged.
			if (claim.status !== "acquired") continue;

			// Intermediate settled turns are acknowledged without being sent.
			if (kind === "settled") {
				acknowledgeRestoredInboxDelivery({
					rootDir,
					nodeId: inbox.nodeId,
					deliveryId: inbox.deliveryId,
					token: claim.token,
					sessionFile,
					settledActivitySequence: activitySequence,
				});
				continue;
			}

			const childSessionFile = childSessionLocation(rootDir, inbox.nodeId)?.sessionFile ?? reduceLineage(rootDir).nodes.get(inbox.nodeId)?.sessionFile ?? inbox.sessionFile;
			try {
				sendSubagentResult(runtime.pi, resultContent, {
					...inbox.payload,
					executionOwner: readExecutionOwner(inbox.payload.executionOwner),
					kind,
					childId: inbox.nodeId,
					sessionFile: childSessionFile,
					deliveryId: inbox.deliveryId,
					resultContent,
				});
			} catch {
				// Nothing was queued, so the claim stays retryable.
				releaseLineageInboxMaterialization({
					rootDir,
					deliveryId: inbox.deliveryId,
					nodeId: inbox.nodeId,
					token: claim.token,
					hasExactSessionEvidence: () => sessionContainsDelivery(sessionFile, inbox.deliveryId),
				});
				continue;
			}
			runtime.inflightDeliveries.set(inbox.deliveryId, { rootDir, nodeId: inbox.nodeId, token: claim.token });
			acknowledgeRestoredInboxDelivery({
				rootDir,
				nodeId: inbox.nodeId,
				deliveryId: inbox.deliveryId,
				token: claim.token,
				sessionFile,
				requiresParentRecord: true,
				settledActivitySequence: activitySequence,
			});
		}
	}
}
/** Save task facts and integration outcome before delivery and owned-resource cleanup. */
function replicaRecordFor(running: RunningSubagent): string | undefined {
  return running.replicaWorkFile ?? readSessionBinding(running.sessionFile)?.child?.environment.PI_SUBAGENT_REPLICA_WORK_FILE;
}
function finishReplicationResult(running: RunningSubagent, result: SubagentResult): void {
  if (running.pendingTerminalDelivery || running.replicaFinishing || (running.replicaRetryAt ?? 0) > Date.now()) return;
  const failed = result.exitCode !== 0 || !!result.errorMessage || !!result.error || !result.summary?.trim();
  const completion: ReplicaCompletion = {
    name: running.name, task: running.task, summary: result.summary ?? "", exitCode: failed ? 1 : 0, elapsed: result.elapsed,
    ...(failed ? { errorMessage: result.errorMessage ?? result.error ?? "Replica failed." } : {}),
  };
  running.pendingReplicaResult = completion;
  running.replicaFinishing = true;
  void completeReplicaInBackground(running, completion).catch((error) => {
    recordDeliveryFailure(running, `terminal:${running.id}`, error, "replica-completion");
    running.replicaRetryAt = Date.now() + 2_000;
  }).finally(() => { running.replicaFinishing = false; });
}
async function completeReplicaInBackground(running: RunningSubagent, completion: ReplicaCompletion): Promise<void> {
  const recordFile = replicaRecordFor(running);
  if (!recordFile) throw new Error("Replica has no durable work record.");
  const location = running.lineage && childSessionLocation(running.lineage.rootDir, running.id);
  const ctx = exactParentSessionActive(running) ? runtime.latestCtx : undefined;
  const sessionFile = ctx?.sessionManager.getSessionFile();
  const parent = sessionFile ? parentSessionLocation(sessionBindingStore(sessionFile), ctx!.sessionManager.getSessionId()) : undefined;
  const { work } = await runReplicaBackground({
    operation: "complete", file: recordFile, cwd: location?.cwd ?? running.worktree!.path,
    sessionFile: running.sessionFile, completion, parent,
  });
  if (!work?.completion) throw new Error("Replica worker returned no saved completion.");
  running.pendingReplicaResult = work.completion;
  if (work.integration.status === "pending" || !exactParentSessionActive(running)) return;
  const saved = work.completion;
  const failed = saved.exitCode !== 0 || !!saved.error || !!saved.errorMessage || !saved.summary.trim();
  const history = saved.historyPath
    ? `Textual answer history: ${saved.historyPath}`
    : `Textual answer history unavailable: ${saved.historyError ?? "No saved history."}`;
  let summary = failed ? [`Replica failed: ${saved.errorMessage ?? saved.error ?? "Replica failed."}`, saved.summary.trim(), history].filter(Boolean).join("\n\n") : saved.summary;
  const report = work.integration.status === "applied" ? ""
    : work.integration.status === "conflict"
      ? "The copy finished, but its changes conflict with your current work and were not included."
      : work.integration.status === "not-attempted"
        ? "The copy's unfinished work was not included in your work."
        : "The copy finished, but its changes could not be safely included in your work.";
  if (report) summary += `\n\n${report}`;
  running.pendingReplicaResult = undefined;
  queueTerminalDelivery(running, terminalAssistantIdentityFor(running), () => {
    if (runtime.pi) sendSubagentResult(runtime.pi, summary, {
      name: running.name, task: running.task, childId: running.id, sessionFile: work.sessionCheckpoint ?? running.sessionFile,
      deliveryId: `terminal:${running.id}`, resultContent: summary,
      exitCode: saved.exitCode, elapsed: saved.elapsed, replication: true,
      ...(failed ? { errorMessage: saved.errorMessage, historyPath: saved.historyPath, historyError: saved.historyError } : {}),
      worktreePath: work.worktree?.path, checkpoint: work.checkpoint?.commit,
      integration: work.integration,
    });
  }, summary, failed ? "error" : "completed");
}
/** Rebuild direct-child watchers from durable launch metadata after a process restart. */
function startRecoveredWatcher(running: RunningSubagent): void {
  const controller = new AbortController();
  running.abortController = controller;
  void watchSubagent(running, controller.signal).then((result) => {
    if (result.supervisionEpoch !== (running.supervisionEpoch ?? 0)) return;
    if (running.replication) { finishReplicationResult(running, result); return; }
    if (result.ping) {
      queueTerminalDelivery(running, undefined, () => {
        if (runtime.pi) runtime.pi.sendMessage({ customType: "subagent_ping", content: result.ping?.message ?? "Recovered subagent needs help.", display: true, details: { ...linkedOutputDetails(running.executionOwner), name: running.name, childId: running.id, sessionFile: running.sessionFile } }, { triggerTurn: true, deliverAs: "steer" });
      }, result.ping.message);
      return;
    }
    const summary = result.summary ?? result.errorMessage ?? "Recovered subagent completed.";
    const presentation = resolveResultPresentation({ ...result, summary, sessionFile: running.sessionFile }, running.name, running.runtimePlan?.runtimeMismatch);
    queueTerminalDelivery(running, terminalAssistantIdentityFor(running), () => {
      if (runtime.pi) sendSubagentResult(runtime.pi, presentation, { name: running.name, task: running.task, childId: running.id, ...(result.closeWithAnswer ? {} : { exitCode: result.exitCode }), sessionFile: running.sessionFile, deliveryId: `terminal:${running.id}`, resultContent: summary });
    }, summary, result.cancelledByUser ? "cancelled" : result.recoveryFailed ? "recovery-failed" : result.closeWithAnswer ? "closed" : undefined);
  }).catch((error) => {
    recordDeliveryFailure(running, `terminal:${running.id}`, error, "recovered-watcher");
  });
}

/** Rebuild direct-child watchers from durable launch metadata after a process restart. */
async function startRestoredSubagentWatcher(running: RunningSubagent): Promise<void> {
	startRecoveredWatcher(running);
}

function restoreLineageRuntime(ctx: ExtensionContext): void {
  const manager = ctx.sessionManager;
  if (!manager || typeof manager.getSessionId !== "function" || typeof manager.getSessionFile !== "function" || typeof manager.getSessionDir !== "function") return;
  const sessionId = manager.getSessionId();
  const sessionFile = manager.getSessionFile();
  if (!sessionFile) return;
  const roots = discoverLineageRoots(manager.getSessionDir(), sessionFile);
  try {
    for (const run of readdirSync(join(ctx.cwd, ".pi", "plans"), { withFileTypes: true })) {
      if (!run.isDirectory()) continue;
      for (const lineage of readdirSync(join(ctx.cwd, ".pi", "plans", run.name, "lineage"), { withFileTypes: true })) {
        if (lineage.isDirectory()) roots.push(join(ctx.cwd, ".pi", "plans", run.name, "lineage", lineage.name));
      }
    }
  } catch {}
  for (const rootDir of new Set(roots)) {
    const state = reduceLineage(rootDir);
    const integrity = lineageIntegrityError(state);
    if (integrity) throw new Error(integrity);
    for (const node of state.nodes.values()) {
      const cancellationPending = !!node.cancellation?.intent && !node.terminal;
      if (node.parentSessionId !== sessionId) continue;
      if (!node.sessionFile || !node.surface) continue;
      if (!cancellationPending && (!node.activityFile || !node.settledEventsFile)) continue;
      const drained = node.terminal && node.terminalDelivered;
      if (drained && !node.cleanupPending) continue;
      if (runningSubagents.has(node.nodeId)) continue;
      let baseline: SessionBaselineCursor;
      try { baseline = captureSessionBaseline(node.sessionFile); } catch { baseline = { sessionFile: node.sessionFile, entryCount: 0, leafId: null, assistantEntryIds: [] }; }
      const lineage: LineageRegistration = {
        rootDir,
        rootId: state.rootId,
        nodeId: node.nodeId,
        ...(node.parentNodeId ? { parentNodeId: node.parentNodeId } : {}),
        ...(node.parentSessionId ? { parentSessionId: node.parentSessionId } : {}),
        ...(node.parentSessionFile ? { parentSessionFile: node.parentSessionFile } : {}),
        launchKind: (node.launchKind as LineageRegistration["launchKind"]) ?? "fresh",
      };
      const running: RunningSubagent = {
        lineage,
        executionOwner: node.executionOwner,
        id: node.nodeId,
        name: node.name ?? node.nodeId,
        task: node.task ?? "recovered subagent",
        agent: node.agent,
        surface: node.surface,
        startTime: node.startTime ?? Date.now(),
        ...(node.tabId ? { tabId: node.tabId } : {}),
        sessionFile: node.sessionFile,
        activityFile: node.activityFile,
        settledEventsFile: node.settledEventsFile,
        sessionBaseline: baseline,
        interactive: node.interactive ?? false,
        runtimePlan: undefined,
        ...(node.workspaceId && node.cwd
          ? { recoveryWorkspace: { id: node.workspaceId, cwd: node.cwd } }
          : {}),
        ...(node.worktree ? { worktree: node.worktree } : {}),
        ...(node.replication ? { replication: true, replicaWorkFile: node.replicaWorkFile } : {}),
        lifecycle: createLifecycle(node.startTime ?? Date.now()),
        cleanupPending: !!node.cleanupPending,
        // A drained node is finished: its result was delivered in an earlier
        // process, so it must not take a widget row while its pane is closed.
        ...(drained ? { retired: true } : {}),
      };
      runningSubagents.set(running.id, running);
      refreshChildLocation(running);
      if (running.lineage) running.lineage.parentSessionFile = sessionFile;
      if (running.tabId) rememberPaneTab(running.surface, running.tabId);
      const recordFile = running.replication && replicaRecordFor(running);
      const savedReplica = recordFile ? readReplicaWork(recordFile).completion : undefined;
      if (savedReplica && !drained) {
        finishReplicationResult(running, savedReplica);
      } else if (cancellationPending) {
        void attemptPendingCancellation(running);
      } else if (node.terminal && !node.terminalDelivered) {
        queueTerminalDelivery(running, undefined, () => {
          if (runtime.pi && runtime.latestCtx?.sessionManager.getSessionId() === sessionId && runtime.latestCtx.sessionManager.getSessionFile() === sessionFile) {
            sendSubagentResult(runtime.pi, node.terminal?.resultContent ?? "Recovered subagent terminal result.", { name: running.name, childId: running.id, sessionFile: running.sessionFile, resultContent: node.terminal?.resultContent ?? "Recovered subagent terminal result." });
          }
        }, node.terminal.resultContent);
      } else if (!drained) {
        void startRestoredSubagentWatcher(running).catch((error) => {
          recordDeliveryFailure(running, `recovery:${running.id}`, error, "startup-recovery");
        });
      } else {
        // Cleanup-pending rows are retried after restart without redelivering.
        if (tryCleanupSubagentSurface(running)) runningSubagents.delete(running.id);
      }
    }
  }
}

export function shouldPreserveSubagentsOnShutdown(reason: unknown): boolean {
	// A deliberate quit (and an unknown shutdown reason) must not turn durable
	// descendants into cancellations. Explicit cancellation owns its own gate.
	return (
		reason == null ||
		reason === "reload" ||
		reason === "new" ||
		reason === "resume" ||
		reason === "fork" ||
		reason === "quit"
	);
}

export function cleanupSubagentsForShutdown(
	reason: unknown,
	agents: Map<string, Pick<RunningSubagent, "abortController" | "lifecycle">>,
): void {
	if (shouldPreserveSubagentsOnShutdown(reason)) return;

	for (const agent of agents.values()) {
		if (agent.lifecycle) {
			agent.lifecycle = markDelivery(agent.lifecycle, "suppressed");
		}
		agent.abortController?.abort();
	}
	agents.clear();
}

export function shouldDeliverSubagentCompletion(
	running: Pick<RunningSubagent, "lifecycle">,
): boolean {
	// Authoritative gate: only pending deliveries may be sent.
	// Missing lifecycle (pre-migration fixtures) defaults to pending/true.
	return (running.lifecycle?.delivery ?? "pending") === "pending";
}

export function selectCompletionApi<T>(previous: T, current: T | undefined): T {
	return current ?? previous;
}

// ── Widget management ──

/** Interval timer for widget re-renders. */
let widgetInterval: ReturnType<typeof setInterval> | null = null;

/** Interval timer for status transition checks. */
let statusInterval: ReturnType<typeof setInterval> | null = null;

function formatElapsedMMSS(startTime: number, endTime = Date.now()): string {
	const seconds = Math.floor((endTime - startTime) / 1000);
	const m = Math.floor(seconds / 60);
	const s = seconds % 60;
	return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

const ACTIVE_ACCENT = "\x1b[38;2;77;163;255m";
const OPEN_ACCENT = "\x1b[38;2;214;158;46m";
const RST = "\x1b[0m";

/**
 * Build a bordered content line: │left          right│
 * Left content is truncated if needed, right is preserved, padded to fill width.
 */
function borderLine(
	left: string,
	right: string,
	width: number,
	accent = ACTIVE_ACCENT,
): string {
	if (width <= 0) return "";
	if (width === 1) return `${accent}│${RST}`;

	// width = total visible chars for the whole line including │ and │
	const contentWidth = Math.max(0, width - 2); // space inside the two │ chars
	const rightVis = visibleWidth(right);

	// If the status chunk alone is too wide, prefer preserving it in compact form
	// rather than overflowing the terminal.
	if (rightVis >= contentWidth) {
		const truncRight = truncateToWidth(right, contentWidth);
		const rightPad = Math.max(0, contentWidth - visibleWidth(truncRight));
		return `${accent}│${RST}${truncRight}${" ".repeat(rightPad)}${accent}│${RST}`;
	}

	const maxLeft = Math.max(0, contentWidth - rightVis);
	const truncLeft = truncateToWidth(left, maxLeft);
	const leftVis = visibleWidth(truncLeft);
	const pad = Math.max(0, contentWidth - leftVis - rightVis);
	return `${accent}│${RST}${truncLeft}${" ".repeat(pad)}${right}${accent}│${RST}`;
}

/**
 * Build the bordered top line: ╭─ Title ──── info ─╮
 * All chars are accounted for within `width`.
 */
function borderTop(
	title: string,
	info: string,
	width: number,
	accent = ACTIVE_ACCENT,
): string {
	if (width <= 0) return "";
	if (width === 1) return `${accent}╭${RST}`;

	// ╭─ Title ───...─── info ─╮
	// overhead: ╭─ (2) + space around title (2) + space around info (2) + ─╮ (2) = but we simplify
	const inner = Math.max(0, width - 2); // inside ╭ and ╮
	const titlePart = `─ ${title} `;
	const infoPart = ` ${info} ─`;
	const fillLen = Math.max(0, inner - titlePart.length - infoPart.length);
	const fill = "─".repeat(fillLen);
	const content = `${titlePart}${fill}${infoPart}`
		.slice(0, inner)
		.padEnd(inner, "─");
	return `${accent}╭${content}╮${RST}`;
}

/**
 * Build the bordered bottom line: ╰──────────────────╯
 */
function borderBottom(width: number, accent = ACTIVE_ACCENT): string {
	if (width <= 0) return "";
	if (width === 1) return `${accent}╰${RST}`;

	const inner = Math.max(0, width - 2);
	return `${accent}╰${"─".repeat(inner)}╯${RST}`;
}

function formatLifecycleWidgetLabel(
	projection: ReturnType<typeof projectLifecycle>,
	now: number,
): string {
	const duration =
		projection.stateDurationSince == null
			? ""
			: ` ${formatElapsedDuration(now - projection.stateDurationSince)}`;
	if (projection.kind === "active")
		return projection.label
			? ` active · ${projection.label}${duration} `
			: ` active${duration} `;
	if (projection.kind === "blocked") return ` blocked${duration} `;
	if (projection.kind === "running") return " running… ";
	if (projection.kind === "waiting") return ` waiting${duration} `;
	if (projection.kind === "interrupted") return ` interrupted${duration} `;
	if (projection.kind === "stalled") return ` stalled${duration} `;
	// completed/failed exist as lifecycle projections for delivery bookkeeping,
	// but the row is removed immediately after result delivery — so the only
	// visible terminal handoff label is finalizing.
	if (
		projection.kind === "finalizing" ||
		projection.kind === "completed" ||
		projection.kind === "failed"
	) {
		return " finalizing… ";
	}
	return " starting… ";
}

function renderSubagentWidgetLines(
	agents: RunningSubagent[],
	width: number,
): string[] {
	const now = Date.now();
	// A retired child is delivered and finished. Its row is gone even while the
	// pane is still being closed.
	const rendered = agents
		.filter((agent) => !agent.retired)
		.map((agent) => ({
			agent,
			projection: projectLifecycle(ensureLifecycle(agent), now),
		}));
	if (rendered.length === 0) return [];
	const activeCount = rendered.filter(
		({ projection }) =>
			projection.kind === "active" ||
			projection.kind === "starting" ||
			projection.kind === "running" ||
			projection.kind === "blocked",
	).length;
	const openCount = rendered.length - activeCount;
	const info =
		activeCount > 0
			? openCount > 0
				? `${activeCount} active · ${openCount} open`
				: `${activeCount} active`
			: `${openCount} open`;
	const accent = activeCount > 0 ? ACTIVE_ACCENT : OPEN_ACCENT;

	const lines: string[] = [borderTop(rendered.every(({ agent }) => agent.replication) ? "Replicas" : "Subagents", info, width, accent)];

	for (const { agent, projection } of rendered) {
		const elapsed = formatElapsedMMSS(
			agent.startTime,
			projection.runtimeEndedAt ?? now,
		);
		const agentTag = agent.agent ? ` (${agent.agent})` : "";
		const left = ` ${elapsed}  ${agent.name}${agentTag} `;
		const runtimeTag = agent.runtimePlan
			? `${agent.runtimePlan.modelId}|${agent.runtimePlan.thinking} · `
			: "";
		const lifecycleLabel = agent.cleanupPending
			? "cleanup pending"
			: agent.recoveryState
				? agent.recoveryState.label
				: agent.deliveryFailure
					? `delivery-failed ${agent.deliveryFailure.deliveryId}`
					: formatLifecycleWidgetLabel(projection, now).trim();
		const right = statusConfig.enabled
			? ` ${runtimeTag}${lifecycleLabel} `
			: ` ${runtimeTag}${agent.cleanupPending ? "cleanup pending" : "starting…"} `;

		lines.push(borderLine(left, right, width, accent));
	}

	lines.push(borderBottom(width, accent));
	return lines;
}

function updateWidget() {
	const latestCtx = runtime.latestCtx;
	if (!latestCtx?.hasUI) return;

	const visible = Array.from(runningSubagents.values()).filter((agent) => !agent.retired);
	if (visible.length === 0) {
		latestCtx.ui.setWidget("subagent-status", undefined);
		if (widgetInterval) {
			clearInterval(widgetInterval);
			widgetInterval = null;
			(globalThis as any)[WIDGET_INTERVAL_KEY] = null;
		}
		return;
	}

	latestCtx.ui.setWidget(
		"subagent-status",
		(_tui: any, _theme: any) => {
			return {
				invalidate() {},
				render(width: number) {
					return renderSubagentWidgetLines(visible, width);
				},
			};
		},
		{ placement: "aboveEditor" },
	);
}

/**
 * Build the positional prompt args for a Pi CLI subagent launch.
 *
 * In artifact-backed launches (lineage-only, standalone), Pi's buildInitialMessage()
 * concatenates @file content with messages[0] into one initial prompt. That breaks
 * /skill: expansion because the message no longer starts with "/skill:". Only
 * messages[1..] are sent as separate follow-up prompts where /skill: is recognized.
 *
 * When there are skill prompts AND artifact-backed delivery, we prepend an empty
 * first positional message so that /skill: args land in messages[1..] and arrive
 * as standalone prompts in the child session.
 */
function buildPiPromptArgs(params: {
	effectiveSkills?: string;
	taskDelivery: "direct" | "artifact";
	taskArg: string;
}): string[] {
	const skillPrompts = (params.effectiveSkills ?? "")
		.split(",")
		.map((s) => s.trim())
		.filter(Boolean)
		.map((skill) => `/skill:${skill}`);

	const needsSeparator =
		params.taskDelivery === "artifact" && skillPrompts.length > 0;

	return [...(needsSeparator ? [""] : []), ...skillPrompts, params.taskArg];
}

function ensureLifecycle(running: RunningSubagent): SubagentLifecycle {
	if (running.lifecycle) return running.lifecycle;
	let lifecycle = createLifecycle(running.startTime);
	const state = running.statusState;
	if (
		state?.activityLabel === "interrupted" &&
		state.localOverrideAtMs != null
	) {
		lifecycle = markInterruptRequested(lifecycle, state.localOverrideAtMs);
	} else if (state?.phase === "done") {
		// Legacy activity "done" means the turn ended, not that completion
		// evidence was recorded. Hydrate as Herdr-style waiting and let the
		// preserved watcher consume sidecar/sentinel evidence.
		const observedAt = state.lastActivityAtMs ?? running.startTime;
		lifecycle = observePaneInspection(
			lifecycle,
			{ kind: "present", observedAt, agentStatus: "done" },
			observedAt,
		);
	} else if (
		state?.phase === "active" ||
		state?.phase === "waiting" ||
		state?.phase === "starting"
	) {
		lifecycle = observeActivity(
			lifecycle,
			{
				ok: true,
				activity: {
					version: 1,
					runningChildId: running.id,
					createdAt: running.startTime,
					updatedAt: state.lastActivityAtMs ?? running.startTime,
					sequence: state.lastActivitySequence ?? 0,
					latestEvent:
						state.latestEvent === "agent_end" ? "agent_end" : "agent_start",
					phase: state.phase,
					agentActive: state.phase === "active",
					turnActive: state.phase === "active",
					providerActive: false,
					toolActive: state.activeScope === "tool",
          ...(state.activeScope
            ? { activeScope: state.activeScope as any }
            : {}),
					...(state.activeSinceMs == null
						? {}
						: { activeSince: state.activeSinceMs }),
					...(state.waitingSinceMs == null
						? {}
						: { waitingSince: state.waitingSinceMs }),
					...(state.activityLabel && state.activeScope === "tool"
						? { toolName: state.activityLabel }
						: {}),
				},
			},
			state.lastActivityAtMs ?? running.startTime,
		);
	} else if (running.startTime) {
		// Pre-lifecycle Pi agents without a known phase still get a running process.
		lifecycle = markProcessRunning(lifecycle, running.startTime);
	}
	running.lifecycle = lifecycle;
	return lifecycle;
}

function settledAssistantFor(
  running: RunningSubagent,
): NewestAssistantEntry | null {
	if (!running.sessionBaseline) return null;
	try {
    const read = readEntriesAfterBaseline(
      running.sessionFile,
      running.sessionBaseline,
    );
		return findNewestAppendedAssistant(read.entries);
	} catch {
		return null;
	}
}

/** Match one session assistant to the durable evidence for a settled boundary. */
function matchesSettledAssistant(
	assistant: NewestAssistantEntry,
	event: SettledActivityEvent,
): boolean {
	if (event.stopReason != null && assistant.stopReason !== event.stopReason) {
		return false;
	}
	if (event.errorMessage != null && assistant.errorMessage !== event.errorMessage) {
		return false;
	}
	if (event.empty != null && assistant.empty !== event.empty) {
		return false;
	}
	switch (event.outcome) {
		case "clean": {
			return (
				!assistant.empty &&
				!!assistant.text?.trim() &&
				assistant.stopReason !== "toolUse" &&
				assistant.stopReason !== "error" &&
				assistant.stopReason !== "aborted"
			);
		}
		case "empty": {
			return assistant.empty;
		}
		case "error": {
			return assistant.stopReason === "error" || assistant.errorMessage != null;
		}
		case "intentional-abort":
		case "unexpected-abort": {
			return assistant.stopReason === "aborted";
		}
	}
}

/**
 * Correlate ordered settled boundaries with session assistants.
 *
 * Durable event ids are preferred, but older/fallback children can record an
 * id that is not the JSONL entry id. In that case evidence and session order
 * select the next matching final assistant, skipping tool-use control entries.
 */
function correlateSettledAssistants(
	events: readonly SettledActivityEvent[],
	assistantPool: readonly NewestAssistantEntry[],
): Map<number, NewestAssistantEntry> {
	const matches = new Map<number, NewestAssistantEntry>();
	const usedAssistantIds = new Set<string>();
	let sessionCursor = -1;

	for (const event of events) {
		let assistant: NewestAssistantEntry | null = null;
		let assistantIndex = -1;
		if (event.assistantId) {
			assistantIndex = assistantPool.findIndex(
				(candidate, index) =>
					index > sessionCursor &&
					candidate.id === event.assistantId &&
					!usedAssistantIds.has(candidate.id) &&
					matchesSettledAssistant(candidate, event),
			);
			if (assistantIndex >= 0) assistant = assistantPool[assistantIndex];
		}
		if (!assistant) {
			assistantIndex = assistantPool.findIndex(
				(candidate, index) =>
					index > sessionCursor &&
					!usedAssistantIds.has(candidate.id) &&
					matchesSettledAssistant(candidate, event),
			);
			if (assistantIndex >= 0) assistant = assistantPool[assistantIndex];
		}
		if (!assistant) continue;
		usedAssistantIds.add(assistant.id);
		sessionCursor = assistantIndex;
		matches.set(event.sequence, assistant);
	}
	return matches;
}

function terminalAssistantIdentityFor(
	running: RunningSubagent,
): SettledDeliveryIdentity | undefined {
	const finalAssistant = settledAssistantFor(running);
	if (!finalAssistant) return undefined;

	let assistantEntryId = finalAssistant.id;
	// An explicit subagent_done writes a tool-call assistant entry before the
	// session shuts down. That control entry is not the response represented by
	// the latest settled boundary, so correlate terminal cleanup with the
	// durable settled identity instead of redelivering its text.
	if (finalAssistant.stopReason === "toolUse" && running.settledEventsFile) {
		const events = orderSettledActivityEvents(readSubagentSettledEventsFile(
			running.settledEventsFile,
			running.id,
		));
		const assistantPool = settledAssistants(running);
		const correlated = correlateSettledAssistants(events, assistantPool);
		let latestSettledAssistant: NewestAssistantEntry | null = null;
		for (const event of events) {
			const assistant = correlated.get(event.sequence);
			if (assistant) latestSettledAssistant = assistant;
		}
		if (
			latestSettledAssistant &&
			latestSettledAssistant.id !== finalAssistant.id
		) {
			assistantEntryId = latestSettledAssistant.id;
		}
	}

	return {
		childId: running.id,
		sessionFile: running.sessionFile,
		assistantEntryId,
	};
}

function settledAssistants(running: RunningSubagent): NewestAssistantEntry[] {
	if (!running.sessionBaseline) return [];
	try {
		return readEntriesAfterBaseline(running.sessionFile, running.sessionBaseline).entries
			.map((entry) => findNewestAppendedAssistant([entry]))
			.filter((assistant): assistant is NewestAssistantEntry => assistant != null);
	} catch {
		return [];
	}
}

/** Follow a child whose new Pi incarnation registered before the source pane closed. */
function refreshChildLocation(running: RunningSubagent): void {
  if (!running.lineage) return;
  const location = childSessionLocation(running.lineage.rootDir, running.id);
  if (!location) return;
  running.sessionFile = location.sessionFile;
  if (running.sessionBaseline) running.sessionBaseline.sessionFile = location.sessionFile;
  if (location.paneId) running.surface = location.paneId;
  if (location.tabId) { running.tabId = location.tabId; rememberPaneTab(running.surface, location.tabId); }
  if (location.workspaceId) running.recoveryWorkspace = { id: location.workspaceId, cwd: location.cwd };
}

function childMovePending(running: RunningSubagent): boolean {
  const location = running.lineage && childSessionLocation(running.lineage.rootDir, running.id);
  return Boolean(location?.moveDeadline && location.moveDeadline > Date.now());
}
/** Never operate on a pane ID reused by a restarted Herdr server. */
function childPaneOwned(running: RunningSubagent): boolean {
  const location = running.lineage && childSessionLocation(running.lineage.rootDir, running.id);
  if (!location) return true; // Legacy launches have no incarnation record.
  try { return sessionOwnsPane(location, running.surface, getPaneProcessInfo(running.surface).shellPid); }
  catch { return false; }
}
function exactParentSessionActive(running: RunningSubagent): boolean {
  const lineage = running.lineage;
  if (!lineage) return true;
  if (!lineage.parentSessionId || !lineage.parentSessionFile) return false;
  const ctx = runtime.latestCtx;
  if (!ctx || runtime.handoffPending) return false;
  try {
    if (ctx.sessionManager.getSessionId() !== lineage.parentSessionId) return false;
    const file = ctx.sessionManager.getSessionFile();
    if (!file) return false;
    const location = parentSessionLocation(sessionBindingStore(file), lineage.parentSessionId);
    if (location && (location.pid !== process.pid || !sessionLocationAlive(location))) return false;
    lineage.parentSessionFile = file;
    return true;
  }
  catch { return false; }
}

function sessionContainsDelivery(sessionFile: string, deliveryId: string): boolean {
  try {
    return readFileSync(sessionFile, "utf8").split("\n").some((line) => {
      try {
        const entry = JSON.parse(line);
        return entry.type === "custom_message" && entry.customType === "subagent_result" && entry.details?.deliveryId === deliveryId;
      } catch { return false; }
    });
  } catch { return false; }
}

/** Wait for durable descendant delivery before releasing a terminal result. */
async function waitForDescendantDrain(
  running: Pick<RunningSubagent, "lineage" | "id">,
  options: {
    delay?: (ms: number) => Promise<void>;
    now?: () => number;
    onWaitOpen?: (info: { waitedSince: number }) => void;
    onWaitRelease?: (info: { waitedSince: number; waitedMs: number }) => void;
    projectWidget?: (projection: unknown) => void;
    log?: (event: string, fields?: Record<string, unknown>) => void;
  } = {},
): Promise<void> {
  if (!running.lineage) return;
  const childId = running.id;
  const record = options.log ?? ((event: string, fields?: Record<string, unknown>) => {
    const sessionFile = (running as RunningSubagent).sessionFile;
    if (sessionFile) createDeliveryLog({ logPath: join(dirname(sessionFile), "subagent-delivery.log"), now: options.now }).record(event, fields);
  });
  await waitForDeliveryDrain({
    isDrained: () => !hasUndrainedDescendants(reduceLineage(running.lineage!.rootDir), childId),
    delay: options.delay,
    now: options.now,
    onWaitOpen: (info) => {
      options.projectWidget?.({ state: "waiting-on-descendants", childId });
      record("drain-wait-open", { childId, phase: "drain", waitedSince: info.waitedSince });
      options.onWaitOpen?.(info);
    },
    onWaitRelease: (info) => {
      record("drain-wait-release", { childId, phase: "drain", ...info });
      options.onWaitRelease?.(info);
    },
  });
}

function deliveryStatusFor(
	running: RunningSubagent,
	answer: string | undefined,
	explicit?: DeliveryStatus,
): DeliveryStatus {
	if (explicit) return explicit;
	if (!answer) return "empty";
	if (running.lifecycle.process.kind === "failed") {
		return /cancel/i.test(running.lifecycle.process.error) ? "cancelled" : "error";
	}
	if (running.lifecycle.process.kind === "completed") return "completed";
	return "closed";
}

function prepareDurableDelivery(
	running: RunningSubagent,
	deliveryId: string,
	answer: string | undefined,
	status?: DeliveryStatus,
): { resultPath: string; payload: string; status: DeliveryStatus } {
	const resolvedStatus = deliveryStatusFor(running, answer, status);
	const replicaFile = running.replication && replicaRecordFor(running);
	const savedSession = replicaFile ? readReplicaWork(replicaFile).sessionCheckpoint : undefined;
	const handle = materializeResultFile({
		sessionsDir: dirname(savedSession ?? running.sessionFile),
		childSessionId: running.id,
		deliveryId,
		status: resolvedStatus,
		agentName: running.name,
		answer,
		now: Date.now(),
	});
	const payload = frameDeliveryPayload({
		...(running.replication ? { subject: "Replica" as const } : {}),
		status: resolvedStatus,
		agentName: running.name,
		childSessionId: running.id,
		childSessionFile: savedSession ?? running.sessionFile,
		answer,
		resultPath: handle.path,
		deliveryId,
		...(running.lifecycle.process.kind === "failed" && running.lifecycle.process.exitCode !== undefined
			? { exitCode: running.lifecycle.process.exitCode }
			: {}),
	});
	return { resultPath: handle.path, payload, status: resolvedStatus };
}

function observeSettledInterruptBoundary(running: RunningSubagent): void {
	if (!running.settledEventsFile || running.lifecycle.turn.kind !== "interrupted") return;
	const events = orderSettledActivityEvents(readSubagentSettledEventsFile(
		running.settledEventsFile,
		running.id,
	));
	const correlated = correlateSettledAssistants(events, settledAssistants(running));
	const previousActivitySequence = running.lifecycle.turn.previousActivitySequence;
	for (const event of events) {
		const assistant = correlated.get(event.sequence);
		if (!assistant || assistant.stopReason !== "aborted") continue;
		if (
			previousActivitySequence == null ||
			event.sequence > previousActivitySequence
		) {
			running.lifecycle = consumeInterruptBoundary(running.lifecycle, event.sequence);
		}
	}
}

function tryCleanupSubagentSurface(running: RunningSubagent): boolean {
  if (running.worktree && !running.replication) return true;
  try {
    const workFile = running.replication && replicaRecordFor(running);
    if (workFile) {
      if (!runtime.latestCtx || running.replicaCleaning) return false;
      running.replicaCleaning = true;
      void runReplicaBackground({
        operation: "cleanup", file: workFile, parentCwd: runtime.latestCtx.cwd, surface: running.surface,
        ...(running.lineage ? { child: { rootDir: running.lineage.rootDir, nodeId: running.id } } : {}),
      }).then(({ cleaned }) => {
        if (!cleaned) return;
        if (running.lineage) {
          const ackId = `cleanup-done:${running.id}`;
          if (!appendLineageEvent(running.lineage.rootDir, ackId, "cleanup_done", running.id) && !hasLineageEvent(running.lineage.rootDir, ackId, "cleanup_done")) throw new Error("Unable to publish cleanup acknowledgement");
        }
        running.cleanupPending = false;
        runningSubagents.delete(running.id);
        updateWidget();
      }).catch((error) => {
        if (running.lineage) appendLineageEvent(running.lineage.rootDir, `cleanup-pending:${running.id}`, "cleanup_pending", running.id, { error: String(error) });
      }).finally(() => { running.replicaCleaning = false; });
      return false;
    } else finalizeSubagentSurface(running, "ready_for_review", false, true);
    running.cleanupPending = false;
    if (running.lineage) {
      const ackId = `cleanup-done:${running.id}`;
      if (!appendLineageEvent(running.lineage.rootDir, ackId, "cleanup_done", running.id) && !hasLineageEvent(running.lineage.rootDir, ackId, "cleanup_done")) throw new Error("Unable to publish cleanup acknowledgement");
    }
    return true;
  } catch (error) {
    const text = String(error);
    if (!running.replication && (text.includes("pane_not_found") || text.includes("not found"))) {
      running.cleanupPending = false;
      if (running.lineage) {
        const ackId = `cleanup-done:${running.id}`;
        if (!appendLineageEvent(running.lineage.rootDir, ackId, "cleanup_done", running.id) && !hasLineageEvent(running.lineage.rootDir, ackId, "cleanup_done")) throw new Error("Unable to publish cleanup acknowledgement");
      }
      return true;
    }
    running.cleanupPending = true;
    if (running.lineage) appendLineageEvent(running.lineage.rootDir, `cleanup-pending:${running.id}`, "cleanup_pending", running.id, { error: text });
    return false;
  }
}

function attemptPendingTerminalDelivery(running: RunningSubagent): void {
  const pending = running.pendingTerminalDelivery;
  if (!pending || pending.queued) return;
  // Queue the terminal job even when a descendant is still active. The owner
  // watcher may finish as soon as its pane closes, so a pre-queue return would
  // strand the terminal result with no later observer to retry it.
  pending.queued = true;
  void enqueueResultDelivery({
    queue: runtime.resultDeliveryQueue,
    childId: running.id,
    deliver: async () => {
      // The terminal observer can run before the last descendant observer has
      // published its terminal-delivered event. Wait here rather than relying
      // on another tick from a pane that may already be gone.
      await waitForDescendantDrain(running);
      const deliveryId = `terminal:${running.id}`;

      const durable = prepareDurableDelivery(running, deliveryId, pending.resultContent, pending.status);
      running.resultPath = durable.resultPath;
      running.deliveryPayload = durable.payload;
      if (running.lineage) {
        if (!appendLineageEvent(running.lineage.rootDir, deliveryId, "terminal", running.id, {
          outcome: "terminal", ...(pending.resultContent ? { resultContent: pending.resultContent } : {}),
        })) {
          const existing = reduceLineage(running.lineage.rootDir).nodes.get(running.id)?.terminal;
          if (!existing) throw new Error("Unable to publish terminal lineage event");
        }
        if (!appendLineageInbox(running.lineage.rootDir, running.id, deliveryId, {
          sessionId: running.lineage.parentSessionId,
          sessionFile: running.lineage.parentSessionFile,
        }, { kind: "terminal", executionOwner: running.executionOwner, resultContent: durable.payload, resultPath: durable.resultPath, status: durable.status })) {
          throw new Error("Unable to publish terminal inbox");
        }

        if (existsSync(`${running.sessionFile}.exit`)) acknowledgeExitSidecar(running.sessionFile);
        const parentActive = exactParentSessionActive(running) && Boolean(runtime.pi);
        if (parentActive) {
          const claim = claimLineageInboxMaterialization({
            rootDir: running.lineage.rootDir,
            deliveryId,
            nodeId: running.id,
            hasExactSessionEvidence: () => sessionContainsDelivery(running.lineage!.parentSessionFile!, deliveryId),
          });
          if (claim.status === "busy") {
            // Another observer owns this delivery, or this process already
            // queued the copy. That is not a delivery failure, so retry quietly
            // instead of projecting an error and feeding the widget a lie.
            pending.queued = false;
            return;
          }
          if (claim.status === "acquired") {
            try {
              await pending.finalize();
              runtime.inflightDeliveries.set(deliveryId, { rootDir: running.lineage.rootDir, nodeId: running.id, token: claim.token });
              acknowledgeRestoredInboxDelivery({
                rootDir: running.lineage.rootDir, nodeId: running.id, deliveryId,
                token: claim.token, sessionFile: running.lineage.parentSessionFile!, requiresParentRecord: true,
              });
            } catch (error) {
              releaseLineageInboxMaterialization({
                rootDir: running.lineage.rootDir,
                deliveryId,
                nodeId: running.id,
                token: claim.token,
                hasExactSessionEvidence: () => sessionContainsDelivery(running.lineage!.parentSessionFile!, deliveryId),
              });
              throw error;
            }
          }
        }
      } else {
        if (existsSync(`${running.sessionFile}.exit`)) acknowledgeExitSidecar(running.sessionFile);
        await pending.finalize();
      }
      const delivered = !running.lineage || appendLineageEvent(running.lineage.rootDir, `terminal-delivered:${running.id}`, "terminal_delivered", running.id, { deliveryId });
      if (!delivered && !reduceLineage(running.lineage!.rootDir).nodes.get(running.id)?.terminalDelivered) throw new Error("Unable to publish terminal delivery evidence");
      running.lifecycle = markDelivery(running.lifecycle, "delivered");
      retireDeliveredSubagent(running);
    },
  }).catch((error) => {
    if (running.pendingTerminalDelivery === pending) pending.queued = false;
    recordDeliveryFailure(running, `terminal:${running.id}`, error, "terminal-delivery");
  });
}

/** Surface cleanup delays after a delivered result, in order, then give up. */
const CLEANUP_RETRY_DELAYS_MS = [2_000, 15_000, 60_000];

/**
 * Retire one delivered child. The result is durable, so its row leaves the
 * widget now and the pane is closed in the background. A rejected Herdr close
 * retries a few times with backoff instead of running once per status tick.
 */
function retireDeliveredSubagent(running: RunningSubagent): void {
  running.retired = true;
  running.pendingTerminalDelivery = undefined;
  const cleaned = tryCleanupSubagentSurface(running);
  running.cleanupPending = !cleaned;
  if (cleaned) {
    runningSubagents.delete(running.id);
  } else {
    running.cleanupAttempts = 1;
    running.cleanupRetryAt = Date.now() + CLEANUP_RETRY_DELAYS_MS[0];
  }
  updateWidget();
}

/** Retry one retired child's surface cleanup without observing it again. */
function retryRetiredSubagentCleanup(running: RunningSubagent, now: number): void {
  if (running.replicaCleaning) return;
  if ((running.cleanupRetryAt ?? 0) > now) return;
  if (tryCleanupSubagentSurface(running)) {
    runningSubagents.delete(running.id);
    updateWidget();
    return;
  }
  const attempts = (running.cleanupAttempts ?? 0) + 1;
  if (attempts > CLEANUP_RETRY_DELAYS_MS.length) {
    // Herdr keeps refusing the close. Keep the durable record and stop retrying
    // so one rejected surface cannot run forever.
    if (running.lineage) {
      try {
        recoveryDeliveryLog(running).record("cleanup-abandoned", {
          childId: running.id,
          surface: running.surface,
          phase: "cleanup",
        });
      } catch {
        // The durable record is best effort.
      }
    }
    runningSubagents.delete(running.id);
    updateWidget();
    return;
  }
  running.cleanupAttempts = attempts;
  running.cleanupRetryAt = now + CLEANUP_RETRY_DELAYS_MS[attempts - 1];
}

function queueTerminalDelivery(
  running: RunningSubagent,
  finalAssistant: SettledDeliveryIdentity | undefined,
  finalize: () => void | Promise<void>,
  resultContent?: string,
  status?: DeliveryStatus,
): void {
  if (running.pendingTerminalDelivery) return;
  running.pendingTerminalDelivery = { finalAssistant, resultContent, status, queued: false, finalize };
  attemptPendingTerminalDelivery(running);
}

function observeRunningSubagent(
	running: RunningSubagent,
	observedAt = Date.now(),
) {
	refreshChildLocation(running);
	if (running.retired) {
		retryRetiredSubagentCleanup(running, observedAt);
		return;
	}
	ensureLifecycle(running);

	const activityFile = running.activityFile;
	const read: ActivityReadResult = activityFile
		? readSubagentActivityFile(activityFile, running.id)
		: { ok: false, reason: "missing" };

	running.activityRead = read.ok
		? { ok: true }
		: { ok: false, reason: read.reason, error: read.error };

	if (read.ok) {
		running.activity = read.activity;
		if (running.recoveryState && read.activity.updatedAt >= running.startTime) {
			recoveryDeliveryLog(running).record("recovery-observed", {
				childId: running.id,
				attempt: running.recoveryState.attempt,
				cause: running.recoveryState.cause,
			});
			running.recoveryState = undefined;
		}
	}
	running.lifecycle = observeActivity(
		ensureLifecycle(running),
		read,
		observedAt,
	);
	observeSettledInterruptBoundary(running);
  if (running.lineage && reduceLineage(running.lineage.rootDir).nodes.get(running.id)?.cancellation?.intent) void attemptPendingCancellation(running);
	if (running.pendingReplicaResult && exactParentSessionActive(running)) finishReplicationResult(running, running.pendingReplicaResult);
	attemptPendingTerminalDelivery(running);
	if (running.cleanupPending) retryRetiredSubagentCleanup(running, observedAt);
}

function resolveInterruptTarget(params: {
	id?: string;
	name?: string;
}): { running: RunningSubagent } | { error: string } {
	const requestedId = params.id?.trim();
	if (requestedId) {
		const running = runningSubagents.get(requestedId);
		return running && !running.retired
			? { running }
			: { error: `No running subagent with id "${requestedId}".` };
	}

	const requestedName = params.name?.trim();
	if (!requestedName) {
		return { error: "Provide a running subagent id or exact display name." };
	}

	const matches = Array.from(runningSubagents.values()).filter(
		(running) => !running.retired && running.name === requestedName,
	);
	if (matches.length === 1) return { running: matches[0] };
	if (matches.length === 0) {
		return { error: `No running subagent named "${requestedName}".` };
	}

	const candidates = matches
		.map((running) => `${running.name} [${running.id}]`)
		.join(", ");
	return {
		error: `Ambiguous subagent name "${requestedName}". Matches: ${candidates}`,
	};
}

function requestSubagentInterrupt(
	running: RunningSubagent,
	interruptPaneKey: (surface: string) => void = interruptPane,
): { ok: true } | { error: string } {
	const marker = `${running.sessionFile}.mechanical-interrupt`;
	try {
		writeFileSync(marker, `${Date.now()}\n`, "utf8");
		interruptPaneKey(running.surface);
		return { ok: true };
	} catch (error: any) {
		rmSync(marker, { force: true });
		return {
			error:
				`Failed to send Escape to subagent "${running.name}" via herdr: ` +
				`${error?.message ?? String(error)}`,
		};
	}
}

interface SubagentInterruptDetails {
	error?: string;
	id?: string;
	name?: string;
	status?: "interrupt_requested";
}

interface SubagentCancelDetails {
	error?: string;
	id?: string;
	name?: string;
	status?: "cancelled" | "cancellation_pending";
}

function sameProcessIdentity(captured: readonly number[], current: readonly number[]): boolean {
  // Processes may exit between restarts; a newly appearing PID means the pane
  // identity was reused and must not be terminated by this cancellation.
  return current.every((pid) => captured.includes(pid));
}

/** Retry a durable cancellation intent, failing closed on uncertain identity. */
async function attemptPendingCancellation(running: RunningSubagent): Promise<boolean> {
  if (!running.lineage) return false;
  if (running.cancellationAttempt) return running.cancellationAttempt;
  const attempt = (async () => {
    const lineage = running.lineage!;
    const state = reduceLineage(lineage.rootDir);
    const node = state.nodes.get(running.id);
    if (!node?.cancellation?.intent || node.terminal) return false;
    let pids = node.cancellation.pids;
    if (pids.length === 0) {
      let info: { pids: number[] };
      try { info = getPaneProcessInfo(node.cancellation.surface ?? running.surface); } catch { return false; }
      if (info.pids.length === 0) return false;
      if (!appendLineageEvent(lineage.rootDir, `cancel-identity:${running.id}`, "cancel_identity", running.id, { surface: node.cancellation.surface ?? running.surface, pids: info.pids })) return false;
      pids = info.pids;
    } else {
      try {
        const current = getPaneProcessInfo(node.cancellation.surface ?? running.surface);
        if (current.pids.length > 0 && !sameProcessIdentity(pids, current.pids)) return false;
      } catch {
        // The pane may already be gone; the persisted PID identity remains the
        // only safe identity to prove has exited.
      }
    }
    try { closePane(node.cancellation.surface ?? running.surface); } catch {}
    let gone: boolean;
    try { gone = await waitForPaneAbsence(node.cancellation.surface ?? running.surface, { timeoutMs: 5_000, intervalMs: 50 }); } catch { gone = false; }
    let survivors: number[];
    try { survivors = await waitForProcessesExit(pids, { timeoutMs: 5_000, intervalMs: 50 }); } catch { survivors = pids; }
    if (!gone || survivors.length > 0) return false;
    const after = reduceLineage(lineage.rootDir).nodes.get(running.id);
    if (after?.terminal) return false;
    if (!appendLineageEvent(lineage.rootDir, `cancel-proven:${running.id}`, "cancel_proven", running.id, { surface: node.cancellation.surface ?? running.surface, pids })) {
      const proven = reduceLineage(lineage.rootDir).nodes.get(running.id)?.cancellation?.proven;
      if (!proven) return false;
    }
    if (!appendLineageEvent(lineage.rootDir, `terminal:${running.id}`, "terminal", running.id, { outcome: "cancelled", resultContent: "Subagent cancelled." })) {
      return !!reduceLineage(lineage.rootDir).nodes.get(running.id)?.terminal;
    }
    if (!running.pendingTerminalDelivery) {
      running.pendingTerminalDelivery = {
        finalAssistant: undefined,
        resultContent: "Subagent cancelled.",

        status: "cancelled",
        queued: false,
        finalize: () => {
          if (!exactParentSessionActive(running)) return;
          if (runtime.pi) sendSubagentResult(runtime.pi, "Subagent cancelled.", { name: running.name, task: running.task, childId: running.id, exitCode: 1, sessionFile: running.sessionFile, deliveryId: `terminal:${running.id}`, resultContent: "Subagent cancelled.", cancellation: true });
        },
      };
    }
    attemptPendingTerminalDelivery(running);
    return true;
  })().finally(() => { running.cancellationAttempt = undefined; });
  running.cancellationAttempt = attempt;
  return attempt;
}

/** Build enough runtime state to finish a descendant whose owning Pi process is gone. */
function recoveredLineageRunning(
  rootDir: string,
  rootId: string,
  node: LineageNodeState,
): RunningSubagent | undefined {
  if (!node.surface || !node.sessionFile) return undefined;
  let baseline: SessionBaselineCursor;
  try {
    baseline = captureSessionBaseline(node.sessionFile);
  } catch {
    baseline = { sessionFile: node.sessionFile, entryCount: 0, leafId: null, assistantEntryIds: [] };
  }
  return {
    lineage: {
      rootDir,
      rootId,
      nodeId: node.nodeId,
      ...(node.parentNodeId ? { parentNodeId: node.parentNodeId } : {}),
      ...(node.parentSessionId ? { parentSessionId: node.parentSessionId } : {}),
      ...(node.parentSessionFile ? { parentSessionFile: node.parentSessionFile } : {}),
      launchKind: (node.launchKind as LineageRegistration["launchKind"]) ?? "fresh",
    },
    id: node.nodeId,
    executionOwner: node.executionOwner,
    name: node.name ?? node.nodeId,
    task: node.task ?? "destroyed descendant",
    agent: node.agent,
    surface: node.surface,
    startTime: node.startTime ?? Date.now(),
    sessionFile: node.sessionFile,
    activityFile: node.activityFile,
    settledEventsFile: node.settledEventsFile,
    sessionBaseline: baseline,
    interactive: false,
    runtimePlan: undefined,
    lifecycle: createLifecycle(node.startTime ?? Date.now()),
  };
}

/** Adopt and terminate descendants after their owning pane is destroyed. */
async function destroyOwnedLineageSubtree(owner: RunningSubagent): Promise<void> {
  if (!owner.lineage) return;
  const { rootDir, rootId } = owner.lineage;
  for (;;) {
    const state = reduceLineage(rootDir);
    const descendants = [...state.nodes.values()].filter((candidate) => {
      let parent = candidate.parentNodeId;
      const seen = new Set<string>();
      while (parent && !seen.has(parent)) {
        if (parent === owner.id) return true;
        seen.add(parent);
        parent = state.nodes.get(parent)?.parentNodeId;
      }
      return false;
    });
    for (const node of descendants.filter((candidate) => candidate.terminal && !candidate.terminalDelivered)) {
      const deliveryId = `terminal:${node.nodeId}`;
      appendLineageInbox(rootDir, node.nodeId, deliveryId, {
        sessionId: node.parentSessionId,
        sessionFile: node.parentSessionFile,
      }, {
        kind: "terminal",
        executionOwner: node.executionOwner,
        ...(node.terminal?.resultContent ? { resultContent: node.terminal.resultContent } : {}),
      });
      appendLineageEvent(rootDir, `terminal-delivered:${node.nodeId}`, "terminal_delivered", node.nodeId, { deliveryId });
    }
    const refreshed = reduceLineage(rootDir);
    const open = [...refreshed.nodes.values()].filter((candidate) => {
      if (candidate.terminal) return false;
      let parent = candidate.parentNodeId;
      const seen = new Set<string>();
      while (parent && !seen.has(parent)) {
        if (parent === owner.id) return true;
        seen.add(parent);
        parent = refreshed.nodes.get(parent)?.parentNodeId;
      }
      return false;
    });
    if (open.length === 0) return;

    let progressed = false;
    for (const node of open) {
      const running = recoveredLineageRunning(rootDir, rootId, node);
      if (!running) {
        const resultContent = "Subagent ownership was destroyed before launch metadata was complete.";
        const deliveryId = `terminal:${node.nodeId}`;
        if (!appendLineageEvent(rootDir, deliveryId, "terminal", node.nodeId, {
          outcome: "pane_closed",
          resultContent,
        }) && !reduceLineage(rootDir).nodes.get(node.nodeId)?.terminal) continue;
        if (!appendLineageInbox(rootDir, node.nodeId, deliveryId, {
          sessionId: node.parentSessionId,
          sessionFile: node.parentSessionFile,
        }, { kind: "terminal", executionOwner: node.executionOwner, resultContent })) continue;
        appendLineageEvent(rootDir, `terminal-delivered:${node.nodeId}`, "terminal_delivered", node.nodeId, { deliveryId });
        progressed = true;
        continue;
      }
      let inspection: PaneInspection;
      try {
        inspection = await inspectPane(running.surface);
      } catch {
        continue;
      }
      if (inspection.kind === "unavailable") continue;
      if (inspection.kind === "missing") {
        const resultContent = "Subagent pane was destroyed with its owning subtree.";
        if (!appendLineageEvent(rootDir, `terminal:${running.id}`, "terminal", running.id, {
          outcome: "pane_closed",
          resultContent,
        }) && !reduceLineage(rootDir).nodes.get(running.id)?.terminal) continue;
        queueTerminalDelivery(running, undefined, () => {}, resultContent);
        progressed = true;
        continue;
      }
      const current = reduceLineage(rootDir).nodes.get(running.id);
      if (!current?.cancellation?.intent) {
        appendLineageEvent(rootDir, `owner-closed:${owner.id}:${running.id}`, "cancel_intent", running.id, {
          surface: running.surface,
        });
      }
      if (await attemptPendingCancellation(running)) progressed = true;
    }
    if (!progressed) await new Promise<void>((resolve) => setTimeout(resolve, 250));
  }
}

/** Persist a user-closed tab as cancellation before descendant drain can release stale settles. */
async function recordManualTabCancellation(running: RunningSubagent): Promise<boolean> {
  if (!running.lineage) return true;
  const { rootDir } = running.lineage;
  const intentId = `manual-tab-close:${running.id}`;
  const current = reduceLineage(rootDir).nodes.get(running.id);
  if (current?.terminal) return false;
  if (!current?.cancellation?.intent) {
    const recorded = appendLineageEvent(rootDir, intentId, "cancel_intent", running.id, {
      surface: running.surface,
      source: "user_tab_close",
    });
    if (!recorded && !reduceLineage(rootDir).nodes.get(running.id)?.cancellation?.intent) {
      throw new Error("Unable to persist manual tab cancellation");
    }
  }
  await destroyOwnedLineageSubtree(running);
  if (reduceLineage(rootDir).nodes.get(running.id)?.terminal) return false;
  const provenId = `manual-tab-close-proven:${running.id}`;
  if (!appendLineageEvent(rootDir, provenId, "cancel_proven", running.id, {
    surface: running.surface,
    pids: [],
    source: "user_tab_close",
  }) && !reduceLineage(rootDir).nodes.get(running.id)?.cancellation?.proven) {
    throw new Error("Unable to prove manual tab cancellation");
  }
  return true;
}

async function handleSubagentCancel(params: { id?: string; name?: string }): Promise<AgentToolResult<SubagentCancelDetails>> {
  const resolved = resolveInterruptTarget(params);
  if ("error" in resolved) return { content: [{ type: "text" as const, text: resolved.error }], details: { error: resolved.error } };
  const running = resolved.running;
  const lineage = running.lineage;
  if (!lineage) return { content: [{ type: "text" as const, text: "Cancellation pending: durable lineage is unavailable." }], details: { id: running.id, name: running.name, status: "cancellation_pending" } };
  const current = reduceLineage(lineage.rootDir).nodes.get(running.id);
  if (current?.terminal) {
    const delivered = !!current.terminalDelivered;
    return { content: [{ type: "text" as const, text: delivered ? `Cancellation already completed for subagent "${running.name}".` : "Cancellation pending: another terminal outcome won the race." }], details: { id: running.id, name: running.name, status: delivered ? "cancelled" : "cancellation_pending" } };
  }
  if (!current?.cancellation?.intent && !appendLineageEvent(lineage.rootDir, `cancel-intent:${running.id}`, "cancel_intent", running.id, { surface: running.surface })) {
    const recorded = reduceLineage(lineage.rootDir).nodes.get(running.id)?.cancellation?.intent;
    if (!recorded) return { content: [{ type: "text" as const, text: "Cancellation pending: could not persist cancellation intent." }], details: { id: running.id, name: running.name, status: "cancellation_pending" } };
  }
  const proved = await attemptPendingCancellation(running);
  const after = reduceLineage(lineage.rootDir).nodes.get(running.id);
  const complete = proved && !running.pendingTerminalDelivery && !!after?.terminalDelivered;
  const raced = !!after?.terminal && after.terminal.outcome !== "cancelled";
  return { content: [{ type: "text" as const, text: raced ? "Cancellation pending: another terminal outcome won the race." : complete ? `Cancellation verified for subagent "${running.name}".` : `Cancellation pending for subagent "${running.name}" until termination proof, descendants, and delivery complete.` }], details: { id: running.id, name: running.name, status: complete ? "cancelled" : "cancellation_pending" } };
}

function handleSubagentInterrupt(
	params: { id?: string; name?: string },
	interruptPaneKey: (surface: string) => void = interruptPane,
): AgentToolResult<SubagentInterruptDetails> {
	const resolved = resolveInterruptTarget(params);
	if ("error" in resolved) {
		return {
			content: [{ type: "text" as const, text: resolved.error }],
			details: { error: resolved.error },
		};
	}

	const running = resolved.running;
	const now = Date.now();
	observeRunningSubagent(running, now);

	const interruption = requestSubagentInterrupt(running, interruptPaneKey);
	if ("error" in interruption) {
		return {
			content: [{ type: "text" as const, text: interruption.error }],
			details: {
				error: interruption.error,
				id: running.id,
				name: running.name,
			},
		};
	}

	running.lifecycle = markInterruptRequested(ensureLifecycle(running), now);
	updateWidget();

	return {
		content: [
			{
				type: "text" as const,
				text: `Interrupt requested for subagent "${running.name}".`,
			},
		],
		details: {
			id: running.id,
			name: running.name,
			status: "interrupt_requested",
		},
	};
}

function ownedDescendantWatchdogState(running: RunningSubagent): {
	waitingForDescendants: boolean;
	descendantActivityAt?: number;
} {
	if (!running.lineage) return { waitingForDescendants: false };
	const state = reduceLineage(running.lineage.rootDir);
	const integrity = lineageIntegrityError(state);
	if (integrity) throw new Error(integrity);
	const descendantActivityAt = latestDescendantDeliveryAt(state, running.id);
	return {
		waitingForDescendants: hasUndrainedDescendants(state, running.id),
		...(descendantActivityAt === undefined ? {} : { descendantActivityAt }),
	};
}

function deliverRecoveryFailure(running: RunningSubagent, reason: string): void {
	running.recoveryFailureReason = reason;
	running.lifecycle = markFailed(ensureLifecycle(running), reason, Date.now(), 1);
	const presentation = resolveResultPresentation({
		summary: reason,
		exitCode: 1,
		elapsed: Math.floor((Date.now() - running.startTime) / 1000),
		sessionFile: running.sessionFile,
		errorMessage: reason,
	}, running.name, running.runtimePlan?.runtimeMismatch);
	queueTerminalDelivery(running, terminalAssistantIdentityFor(running), () => {
		if (runtime.pi) sendSubagentResult(runtime.pi, presentation, {
			name: running.name,
			task: running.task,
			childId: running.id,
			exitCode: 1,
			sessionFile: running.sessionFile,
			deliveryId: `terminal:${running.id}`,
			errorMessage: reason,
			resultContent: reason,
		});
	}, reason, "recovery-failed");
}

async function superviseStaleSubagent(running: RunningSubagent, now: number): Promise<void> {
	// Replica continuation belongs to its parent, never the stale watchdog.
	if (running.retired || running.replication) return;
	if (!shouldStartStaleRecovery({
		interactive: running.interactive,
		pendingTerminalDelivery: Boolean(running.pendingTerminalDelivery),
		recoveryAttemptActive: Boolean(running.recoveryAttempt),
		recoveryExhausted: Boolean(running.recoveryExhausted),
	})) return;
	let descendants: ReturnType<typeof ownedDescendantWatchdogState>;
	try {
		descendants = ownedDescendantWatchdogState(running);
	} catch (error) {
		recordDeliveryFailure(running, `lineage:${running.id}`, error, "lineage-integrity");
		return;
	}
	if (classifyStaleness({
		autonomous: true,
		activity: running.activity,
		startedAt: running.startTime,
		now,
		quietThresholdMs,
		...descendants,
	}) !== "stale") return;

	running.recoveryAttempt = (async () => {
		const recovery = await attemptRecovery(running, "stale");
		if (recovery.recovered) {
			startRecoveredWatcher(running);
			return;
		}
		if (recovery.exhausted) {
			deliverRecoveryFailure(running, recovery.reason ?? "Recovery failed.");
		}
	})().finally(() => {
		running.recoveryAttempt = undefined;
	});
	await running.recoveryAttempt;
}

function startStatusRefresh(_pi: ExtensionAPI) {
	if (statusInterval) return;

	statusInterval = setInterval(() => {
		if (runtime.latestCtx) void restorePendingLineageInboxes(runtime.latestCtx);
		if (runningSubagents.size === 0) {
			if (statusInterval) {
				clearInterval(statusInterval);
				statusInterval = null;
				(globalThis as any)[STATUS_INTERVAL_KEY] = null;
			}
			return;
		}

		const now = Date.now();
		let shouldRefreshWidget = false;
		for (const running of runningSubagents.values()) {
			observeRunningSubagent(running, now);
			void superviseStaleSubagent(running, now);
			const projection = projectLifecycle(ensureLifecycle(running), now);
			if (running.lastProjectedKind !== projection.kind) shouldRefreshWidget = true;
			running.lastProjectedKind = projection.kind;
		}
		if (shouldRefreshWidget) updateWidget();
	}, 1000);

	(globalThis as any)[STATUS_INTERVAL_KEY] = statusInterval;
}

export const __test__ = {
	launchSubagent,
	borderLine,
	renderSubagentWidgetLines,
	loadAgentDefaults,
	discoverAgentDefinitions,
	resolveEffectiveSessionMode,
	resolveLaunchBehavior,
	resolveEffectiveAutoExit,
	resolveEffectiveInteractive,
	buildSubagentToolAllowlist,
	buildPiPromptArgs,
	terminalAssistantIdentityFor,
	observeRunningSubagent,
	restorePendingLineageInboxes,
	attemptRecovery,
	startRecoveredWatcher,
	waitForDescendantDrain,
	resolveDenyTools,
	isSelfSpawnBlocked,
	resolveInterruptTarget,
	recordManualTabCancellation,
	handleSubagentCancel,
	requestSubagentInterrupt,
	handleSubagentInterrupt,
	resolveResultPresentation,
	resolveUnexpectedErrorPresentation,
	sendSubagentResult,
	shouldRetainSubagentSurface,
	captureWorktreeHandoff,
	runSubagentScript,
	writeWorktreeManifest,
	runningSubagents,
	formatElapsed,
};

function startWidgetRefresh() {
	if (widgetInterval) return;
	updateWidget(); // immediate first render
	widgetInterval = setInterval(() => {
		updateWidget();
	}, 1000);
	(globalThis as any)[WIDGET_INTERVAL_KEY] = widgetInterval;
}

/**
 * Launch a subagent: creates the herdr pane, builds the command, and
 * sends it. Returns a RunningSubagent — does NOT poll.
 *
 * Call watchSubagent() on the returned object to observe completion.
 */
async function launchSubagent(
	params: typeof SubagentParams.static,
	ctx: {
		sessionManager: {
			getSessionFile(): string | null | undefined;
			getSessionId(): string;
			getSessionDir(): string;
		};
		cwd: string;
		model?: { provider: string; id: string };
		modelRegistry: {
			find(provider: string, modelId: string): any;
			getAvailable?: () => any[];
			getAll?: () => any[];
			hasConfiguredAuth?: (model: any) => boolean;
		};
	},
	parentThinking: ThinkingLevel,
	options?: {
		surface?: string;
		executionOwner?: ExecutionOwner;
		runtimePlan?: ResolvedRuntimePlan;
		id?: string;
	},
): Promise<RunningSubagent> {
	const id = options?.id ?? Math.random().toString(16).slice(2, 10);

	const agentDefs = params.agent
		? loadAgentDefaults(params.agent, runtime.pi)
		: null;
	if (params.agent && !agentDefs) {
		const diagnostic = discoverAgentCatalog(runtime.pi).diagnostics.find(
			(candidate) => candidate.agentName === params.agent,
		);
		throw new Error(
			diagnostic?.message ?? `Agent "${params.agent}" was not found.`,
		);
	}
	if (!ctx.model)
		throw new Error("Subagent launch requires a resolved parent model");
	const runtimePlan =
		options?.runtimePlan ??
		resolveRuntimePlan(
			{ model: agentDefs?.model, thinking: agentDefs?.thinking },
			{
				provider: ctx.model.provider,
				modelId: ctx.model.id,
				thinking: parentThinking,
			},
			wrapPiModelRegistry(ctx.modelRegistry),
		);
	const effectiveTools = params.tools ?? agentDefs?.tools;
	const effectiveSkills = params.skills ?? agentDefs?.skills;
	const effectiveAutoExit = resolveEffectiveAutoExit(params, agentDefs);
	const effectiveInteractive = resolveEffectiveInteractive(params, agentDefs);
	const parentSessionFile = ctx.sessionManager.getSessionFile();
	if (!parentSessionFile) throw new Error("No session file");

	const running = await launchPiSubagent({
		kind: "fresh",
		id,
		executionOwner: options?.executionOwner,
		name: params.name,
		task: params.task,
		agent: params.agent,
		cwd: params.cwd,
		worktree: params.worktree,
		fork: params.fork,
		surface: options?.surface,
		parent: {
			cwd: ctx.cwd,
			invocationCwd: process.cwd(),
			sessionFile: parentSessionFile,
			sessionId: ctx.sessionManager.getSessionId(),
			sessionDir: ctx.sessionManager.getSessionDir(),
			agentDir: getAgentConfigDir(),
		},
		runtimePlan,
		behavior: {
			tools: effectiveTools,
			skills: effectiveSkills,
			deniedTools: [...resolveDenyTools(agentDefs)],
			autoExit: effectiveAutoExit,
			interactive: effectiveInteractive,
			identity: agentDefs?.body ?? params.systemPrompt,
			systemPromptMode: agentDefs?.systemPromptMode,
			sessionMode: resolveEffectiveSessionMode(params, agentDefs),
			cwd: agentDefs?.cwd,
		},
	});
	runningSubagents.set(id, running);
	return running;
}

/**
 * Watch a launched subagent until it exits. Polls for completion, extracts
 * the summary from the session file, and closes ordinary panes. Worktree
 * workspaces are retained for parent review.
 */
async function deliverHelpRequest(
	running: RunningSubagent,
	ping: { id?: string; name: string; message: string },
): Promise<void> {
	const deliveryId = `help:${running.id}:${ping.id ?? Date.now()}`;
	await waitForDescendantDrain(running);
	const durable = prepareDurableDelivery(running, deliveryId, ping.message, "help-request");
	const details = {
		kind: "help-request",
		name: ping.name,
		task: running.task,
		agent: running.agent,
		childId: running.id,
		sessionFile: running.sessionFile,
		deliveryId,
		resultPath: durable.resultPath,
		resultContent: durable.payload,
	};
	if (running.lineage) {
		if (!appendLineageInbox(
			running.lineage.rootDir,
			running.id,
			deliveryId,
			{
				sessionId: running.lineage.parentSessionId,
				sessionFile: running.lineage.parentSessionFile,
			},
			{ kind: "help-request", executionOwner: running.executionOwner, resultContent: durable.payload, resultPath: durable.resultPath, status: "help-request" },
		)) throw new Error("Unable to publish help-request inbox");

		acknowledgePingSidecar(running.sessionFile, ping.id);
		if (!exactParentSessionActive(running) || !runtime.pi) return;
		const claim = claimLineageInboxMaterialization({
			rootDir: running.lineage.rootDir,
			deliveryId,
			nodeId: running.id,
			hasExactSessionEvidence: () => sessionContainsDelivery(running.lineage!.parentSessionFile!, deliveryId),
		});
		// Another observer owns this help request and will deliver it, so the
		// child continues without recording a false delivery failure.
		if (claim.status === "busy") return;
		if (claim.status === "materialized") return;
		try {
			sendSubagentResult(runtime.pi, durable.payload, details);
			if (!completeLineageInboxMaterialization(running.lineage.rootDir, deliveryId, running.id, claim.token)) {
				throw new Error("Unable to publish help-request materialization acknowledgement");
			}
		} catch (error) {
			releaseLineageInboxMaterialization({
				rootDir: running.lineage.rootDir,
				deliveryId,
				nodeId: running.id,
				token: claim.token,
				hasExactSessionEvidence: () => sessionContainsDelivery(running.lineage!.parentSessionFile!, deliveryId),
			});
			throw error;
		}
	} else {
		if (!runtime.pi) throw new Error("Parent API is unavailable");
		sendSubagentResult(runtime.pi, durable.payload, details);
		acknowledgePingSidecar(running.sessionFile, ping.id);
	}
	createDeliveryLog({ logPath: join(dirname(running.sessionFile), "subagent-delivery.log") })
		.record("delivery-materialized", { childId: running.id, deliveryId, status: "help-request", resultPath: durable.resultPath });
}

async function attemptRecovery(
	running: RunningSubagent,
	cause: RecoveryCause,
): Promise<{ recovered: boolean; exhausted: boolean; reason?: string }> {
	const lineage = running.lineage;
	if (!lineage?.parentSessionId || !lineage.parentSessionFile) {
		return {
			recovered: false,
			exhausted: true,
			reason: "Recovery failed because the exact creator-parent session is unavailable.",
		};
	}

	let budget: ReturnType<typeof consumeRecoveryAttempt>;
	try {
		budget = consumeRecoveryAttempt({
			logPath: recoveryLogPath(running),
			childId: running.id,
			cause,
		});
	} catch (error) {
		return {
			recovered: false,
			exhausted: true,
			reason: `Recovery failed because its durable budget could not be read or written: ${error instanceof Error ? error.message : String(error)}`,
		};
	}
	running.recoveryState = {
		cause,
		attempt: budget.attempt,
		label: budget.exhausted
			? `recovery failed (${budget.attempt}/${3})`
			: `recovering ${cause} (${budget.attempt}/${3})`,
	};
	if (budget.exhausted) {
		// The budget is spent. Killing or resuming again would repeat the same
		// failed attempt once per status tick forever.
		running.recoveryExhausted = true;
		running.recoveryFailureReason = budget.reason;
		return { recovered: false, exhausted: true, reason: budget.reason };
	}
	running.supervisionEpoch = (running.supervisionEpoch ?? 0) + 1;

	if (cause === "stale" && childPaneOwned(running)) {
		recoveryDeliveryLog(running).record("recovery-kill", {
			childId: running.id,
			attempt: budget.attempt,
			cause,
			surface: running.surface,
		});
		try {
			closePane(running.surface);
			await waitForPaneAbsence(running.surface, { timeoutMs: 5_000, intervalMs: 100 });
		} catch (error) {
			recoveryDeliveryLog(running).record("recovery-kill-failed", {
				childId: running.id,
				attempt: budget.attempt,
				cause,
				error,
			});
		}
	}
	updateWidget();

	let reusableSurface: string | undefined;
	if (cause === "crash") {
		try {
			if (childPaneOwned(running)) {
				getPaneProcessInfo(running.surface);
				reusableSurface = running.surface;
			}
		} catch {
			reusableSurface = undefined;
		}
	}

	const priorLocation = childSessionLocation(lineage.rootDir, running.id);
	try {
		const resumed = await launchPiSubagent({
			kind: "resume",
			executionOwner: running.executionOwner,
			id: running.id,
			name: running.name,
			sessionFile: running.sessionFile,
			message: `Your previous process became ${cause === "crash" ? "unavailable" : "stale"}. Resume this exact session and continue the assigned task. Do not repeat already completed work.`,
			...(reusableSurface ? { surface: reusableSurface } : {}),

			...(running.recoveryWorkspace ? { workspace: running.recoveryWorkspace } : {}),
			parent: {
				sessionId: lineage.parentSessionId,
				sessionFile: lineage.parentSessionFile,
				sessionDir: dirname(lineage.parentSessionFile),
			},
			behavior: {
				autoExit: !running.interactive,
				interactive: running.interactive,
			},
		});
		// A launch returns before Pi binds. Do not let the new watcher follow
		// the old closed pane and mistake recovery for a user's cancellation.
		const bindDeadline = Date.now() + 30_000;
		for (;;) {
			const location = childSessionLocation(lineage.rootDir, running.id);
			if (location?.paneId === resumed.surface &&
				(location.pid !== priorLocation?.pid || location.processStart !== priorLocation?.processStart) &&
				sessionOwnsPane(location, resumed.surface, getPaneProcessInfo(resumed.surface).shellPid)) break;
			if (Date.now() >= bindDeadline) throw new Error("Recovery replacement did not register its session location.");
			await new Promise<void>((resolve) => setTimeout(resolve, 100));
		}
		const epoch = running.supervisionEpoch;
		const recoveryState = running.recoveryState;
		const stable = {
			task: running.task,
			agent: running.agent,
			runtimePlan: running.runtimePlan,
			worktree: running.worktree,

			recoveryWorkspace: running.recoveryWorkspace,
		};
		Object.assign(running, resumed, stable);
		running.supervisionEpoch = epoch;

		running.ignorePriorSentinelEpoch = epoch;
		running.recoveryState = recoveryState;
		recoveryDeliveryLog(running).record("recovery-resumed", {
			childId: running.id,
			attempt: budget.attempt,
			cause,
			surface: running.surface,
		});
		updateWidget();
		return { recovered: true, exhausted: false };
	} catch (error) {
		recoveryDeliveryLog(running).record("recovery-launch-failed", {
			childId: running.id,
			attempt: budget.attempt,
			cause,
			error,
		});
		running.recoveryState = {
			cause,
			attempt: budget.attempt,
			label: `recovery launch failed (${budget.attempt}/${3})`,
		};
		updateWidget();
		return { recovered: false, exhausted: false };
	}
}

async function watchSubagent(
	running: RunningSubagent,
	signal: AbortSignal,
): Promise<SubagentResult> {
	const { name, task, startTime } = running;
	let sessionFile = running.sessionFile;

	const supervisionEpoch = running.supervisionEpoch ?? 0;
	let recoveryFailed = false;

	let cancelledByUser = false;

	try {
		let result;
		for (;;) {
			result = await waitForCompletion(signal, {
				intervalMs: 1000,
				sessionFile,
				resolveSessionFile: () => { refreshChildLocation(running); return running.sessionFile; },
				readTerminalTail: () => { refreshChildLocation(running); return !childMovePending(running) && childPaneOwned(running) ? readPaneAsync(running.surface, 5) : Promise.resolve(""); },
				inspectPane: async () => {
					refreshChildLocation(running);
					if (childMovePending(running)) return { kind: "unavailable" as const, error: "Waiting for the Teleport replacement to bind" };
					return childPaneOwned(running) ? inspectPane(running.surface) : { kind: "missing" as const, error: "Original child pane incarnation is gone" };
				},
				onPaneInspection: (inspection: PaneInspection, observedAt: number) => {
					ensureLifecycle(running);
					running.lifecycle = observePaneInspection(
						running.lifecycle,
						inspection,
						observedAt,
					);
					updateWidget();
				},
				onTick() {
					observeRunningSubagent(running);
				},
			});
			sessionFile = running.sessionFile;
			if (supervisionEpoch !== (running.supervisionEpoch ?? 0)) {
				return {
					name,
					task,
					summary: "Superseded by automatic same-session recovery.",
					sessionFile,
					exitCode: 0,
					elapsed: Math.floor((Date.now() - startTime) / 1000),
					supervisionEpoch,
				};
			}
			if (!result.ping) {
				observeRunningSubagent(running);
				if (result.paneDisappeared) {
					const location = running.lineage && childSessionLocation(running.lineage.rootDir, running.id);
					if (!location || (!location.moveDeadline && sessionServerAlive(location) !== false)) {
						cancelledByUser = await recordManualTabCancellation(running);
						break;
					}
					result = { ...result, reason: "sentinel" as const, exitCode: 1, paneDisappeared: undefined };
				}

				if (
					result.reason === "sentinel" &&
					result.exitCode !== 0 &&
					running.ignorePriorSentinelEpoch === supervisionEpoch
				) {
					running.ignorePriorSentinelEpoch = undefined;
					continue;
				}
				if (running.replication && result.reason === "sentinel") {
					result = { reason: "error" as const, exitCode: 1, errorMessage: "Replica process closed without a saved completion." };
					break;
				}
				if (result.reason === "sentinel" && result.exitCode !== 0 && !result.errorMessage) {
					let recovery: Awaited<ReturnType<typeof attemptRecovery>> | undefined;
					const recoveryLock = (async () => {
						recovery = await attemptRecovery(running, "crash");
					})();
					running.recoveryAttempt = recoveryLock;
					try {
						await recoveryLock;
					} finally {
						if (running.recoveryAttempt === recoveryLock) running.recoveryAttempt = undefined;
					}
					if (!recovery) throw new Error("Crash recovery did not produce a result");
					if (recovery.recovered) return watchSubagent(running, signal);
					if (!recovery.exhausted) continue;
					recoveryFailed = true;
					result = {
						reason: "error" as const,
						exitCode: 1,
						errorMessage: recovery.reason ?? "Recovery failed.",
					};
				}
				break;
			}
			try {
				await deliverHelpRequest(running, result.ping);
				running.deliveryFailure = undefined;
				updateWidget();
			} catch (error) {
				recordDeliveryFailure(running, `help:${running.id}:${result.ping.id ?? "unknown"}`, error, "help-request");
			}
		}
		// Refresh the final child state before terminal delivery.
		observeRunningSubagent(running);
		await runtime.resultDeliveryQueue.enqueue(running.id, () => undefined);

		const detectedAt = Date.now();
		running.lifecycle = markCompletionDetected(
			running.lifecycle,
			result,
			detectedAt,
		);
		updateWidget();
		const elapsed = Math.floor((detectedAt - startTime) / 1000);

		let summary: string;

		let lastAssistant: string | null = null;
		if (existsSync(sessionFile)) {
			const allEntries = getNewEntries(sessionFile, 0);
			const observed = findObservedSessionRuntime(allEntries);
			if (running.runtimePlan && observed.provider && observed.modelId) {
				const observedModel = `${observed.provider}/${observed.modelId}`;
				const observedThinking =
					observed.thinking === "off" ||
					observed.thinking === "minimal" ||
					observed.thinking === "low" ||
					observed.thinking === "medium" ||
					observed.thinking === "high" ||
					observed.thinking === "xhigh" ||
					observed.thinking === "max"
						? observed.thinking
						: undefined;
				const mismatch =
					observedModel === running.runtimePlan.model
						? undefined
						: `Resolved model ${running.runtimePlan.model} but child reported ${observedModel}`;
				running.runtimePlan = {
					...running.runtimePlan,
					...(observedThinking ? { thinking: observedThinking } : {}),
					observed: {
						model: observedModel,
						...(observedThinking ? { thinking: observedThinking } : {}),
					},
					...(mismatch ? { runtimeMismatch: mismatch } : {}),
				};
			}
			lastAssistant = running.replication
				? running.sessionBaseline
					? findLastAssistantMessage(readEntriesAfterBaseline(sessionFile, running.sessionBaseline).entries.filter(entry => findNewestAppendedAssistant([entry])?.text?.trim()))
					: null // Without a fork boundary, inherited parent answers are not replica output.
				: findLastAssistantMessage(allEntries);
			summary =
				result.summary ??
				lastAssistant ??
				(result.errorMessage
					? `Subagent error: ${result.errorMessage}`
					: result.exitCode === 0
						? "Sub-agent exited without output"
						: `Sub-agent exited with code ${result.exitCode}`);
		} else {
			summary = result.errorMessage
				? `Subagent error: ${result.errorMessage}`
				: result.exitCode === 0
					? "Sub-agent exited without output"
					: `Sub-agent exited with code ${result.exitCode}`;
		}

		if (cancelledByUser && !running.replication) summary = "Subagent cancelled by user.";
		const closeWithAnswer = !running.replication && !cancelledByUser && !!result.paneDisappeared && !!lastAssistant?.trim();
		const effectiveExitCode = closeWithAnswer ? 0 : result.exitCode;
		if (closeWithAnswer) summary = lastAssistant!;

		const worktreeHandoff = running.replication ? undefined : finalizeSubagentSurface(
			running,
			result.ping
				? "needs_help"
				: effectiveExitCode === 0
					? "ready_for_review"
					: "failed",
			false,
			false,
		);
		running.lifecycle =
			effectiveExitCode === 0
				? markCompleted(running.lifecycle, Date.now())
				: markFailed(
						running.lifecycle,
						result.errorMessage ?? summary,
						Date.now(),
						effectiveExitCode,
					);

		return {
			name,
			task,
			summary,
			sessionFile,
			exitCode: effectiveExitCode,
			elapsed,
			ping: result.ping,
			...(running.replication && cancelledByUser ? { errorMessage: "Replica pane closed without a saved completion." } : !closeWithAnswer && !cancelledByUser && result.errorMessage ? { errorMessage: result.errorMessage } : {}),
			...(closeWithAnswer ? { closeWithAnswer: true as const } : {}),

			supervisionEpoch,
			...(recoveryFailed ? { recoveryFailed: true as const } : {}),

			...(cancelledByUser ? { cancelledByUser: true as const } : {}),
			...(result.paneDisappeared ? { paneDisappeared: true as const } : {}),
			...(worktreeHandoff ? { worktree: worktreeHandoff } : {}),
		};
	} catch (err: any) {
		const worktreeHandoff = running.replication ? undefined : finalizeSubagentSurface(running, "failed", true, false);
		running.lifecycle = markFailed(
			running.lifecycle,
			signal.aborted ? "Subagent cancelled." : (err?.message ?? String(err)),
			Date.now(),
			1,
		);
		updateWidget();

		if (signal.aborted) {
			return {
				name,
				task,
				summary: "Subagent cancelled.",
				exitCode: 1,
				elapsed: Math.floor((Date.now() - startTime) / 1000),
				error: "cancelled",
				sessionFile,
				...(worktreeHandoff ? { worktree: worktreeHandoff } : {}),

				supervisionEpoch,
			};
		}
		return {
			name,
			task,
			summary: `Subagent error: ${err?.message ?? String(err)}`,
			exitCode: 1,
			elapsed: Math.floor((Date.now() - startTime) / 1000),
			error: err?.message ?? String(err),

			supervisionEpoch,
			...(worktreeHandoff ? { worktree: worktreeHandoff } : {}),
		};
	}
}

function installSubagentRuntime(pi: ExtensionAPI) {
	runtime.pi = pi;
	runtime.resolveExecutionOwner = trackExecutionOwners(pi);
	// Capture the UI context for widget updates and restore presentation for
	// subagents whose watchers survived a reload.
	pi.on("session_start", (_event, ctx) => {
		runtime.latestCtx = ctx;
		runtime.handoffPending = false;
		const binding = bindSessionRuntime(pi, ctx);
		const workFile = binding?.child?.environment.PI_SUBAGENT_REPLICA_WORK_FILE;
		const location = binding?.child && childSessionLocation(binding.child.lineage.rootDir, binding.child.lineage.nodeId);
		if (workFile && location) captureReplicaWorkLocation(workFile, location);
		if (binding?.child && !hasChildLifecycle(pi)) subagentLifecycle(pi, ctx);
		restoreLineageRuntime(ctx);
		void restorePendingLineageInboxes(ctx);
		if (runningSubagents.size > 0) {
			startWidgetRefresh();
			startStatusRefresh(pi);
			updateWidget();
		}
	});

	// A session-start replay can race the parent's startup turn. Retry after the
	// agent becomes idle so an "already processing" steer stays durable and pending.
	pi.on("agent_end", () => {
		setTimeout(() => {
			if (runtime.latestCtx) void restorePendingLineageInboxes(runtime.latestCtx);
		}, 0);
	});

	pi.on("tool_call", (event, ctx) => {
		if (event.toolName !== "teleport" || !["jump", "back"].includes(String(event.input.action))) return;
		runtime.handoffPending = true;
		const file = ctx.sessionManager.getSessionFile();
		const binding = file && readSessionBinding(file);
		if (binding) beginChildSessionMove(binding);
	});
	pi.on("tool_result", (event, ctx) => {
		if (event.toolName !== "teleport" || !event.isError) return;
		runtime.handoffPending = false;
		bindSessionRuntime(pi, ctx);
	});
	pi.on("message_end", (event, ctx) => {
		const message = event.message as { customType?: string };
		if (message.customType !== "pi-agent-teleport-failure") return;
		runtime.handoffPending = false;
		bindSessionRuntime(pi, ctx);
	});
	// Clean up on session shutdown
	pi.on("session_shutdown", async (event, _ctx) => {
		runtime.latestCtx = undefined;
		if (widgetInterval) {
			clearInterval(widgetInterval);
			widgetInterval = null;
			(globalThis as any)[WIDGET_INTERVAL_KEY] = null;
		}
		if (statusInterval) {
			clearInterval(statusInterval);
			statusInterval = null;
			(globalThis as any)[STATUS_INTERVAL_KEY] = null;
		}

		const shutdownReason = (event as any).reason;
		cleanupSubagentsForShutdown(shutdownReason, runningSubagents);
	});

	registerSubagentRenderers(pi);
}

/** Register fresh replication while retaining internal launch and delivery APIs. */
export default function subagentsExtension(pi: ExtensionAPI) {
	// Discard the old disclosure handle on reload; in-flight watchers may still use it.
	delete (runtime as SubagentRuntime & { replicateTool?: unknown }).replicateTool;
	registerReplicateTool(pi, async (params, ctx, toolCallId) => {
		const executionOwner = runtime.resolveExecutionOwner?.(toolCallId);
		if (!isTerminalAvailable()) throw new Error("Replication requires Herdr.");
		const file = ctx.sessionManager.getSessionFile();
		if (!file || !ctx.model) throw new Error("Replication requires a persisted session and selected model.");
		const snapshot = {
			entries: JSON.parse(JSON.stringify(ctx.sessionManager.getBranch())),
			contextMessages: JSON.parse(JSON.stringify(replicationContextMessages(ctx))),
			systemPrompt: ctx.getSystemPrompt(),
			extensionArgs: replicationExtensionArgs(process.argv, ctx.cwd),
		};
		bindSessionRuntime(pi, ctx);
		const id = Math.random().toString(16).slice(2, 10);
		const name = replicationName(params.name, pi, ctx, getHerdrCurrentPaneTitle);
		const recordFile = replicaWorkFile(sessionBindingStore(file), id);
		try {
			const source = snapshotSource(ctx.cwd, join(recordFile + ".artifacts", "fork"));
			const inherited = { systemPrompt: snapshot.systemPrompt, extensionArgs: snapshot.extensionArgs, provider: ctx.model.provider, modelId: ctx.model.id, thinking: pi.getThinkingLevel(), tools: pi.getActiveTools() };
			createReplicaWork(recordFile, id, ctx.sessionManager.getSessionId(), source);
			saveReplicaRuntime(recordFile, inherited);
			const plan = resolveRuntimePlan({}, { provider: inherited.provider, modelId: inherited.modelId, thinking: inherited.thinking as ThinkingLevel }, wrapPiModelRegistry(ctx.modelRegistry));
			const child = await launchPiSubagent({
				kind: "fresh", id, name, task: replicationAssignment(params.task), executionOwner,
				fork: true, replication: { ...snapshot, recordFile }, runtimePlan: plan,
				worktree: { branch: await reserveReplicaBranch(ctx.cwd, name, source.commit), base: source.commit },
				parent: { cwd: ctx.cwd, invocationCwd: ctx.cwd, sessionFile: file, sessionId: ctx.sessionManager.getSessionId(), sessionDir: ctx.sessionManager.getSessionDir(), agentDir: getAgentConfigDir() },
				behavior: { tools: inherited.tools.join(","), deniedTools: [], autoExit: true, interactive: false, sessionMode: "fork", includeControlTools: false },
			});
			runningSubagents.set(id, child);
			startWidgetRefresh();
			startStatusRefresh(pi);
			startRecoveredWatcher(child);
			return { id, name, sessionFile: child.sessionFile, worktreePath: child.worktree?.path };
		} catch (error) {
			if (existsSync(recordFile)) failReplicaLaunch(recordFile, error);
			throw error;
		}
	});
	installSubagentRuntime(pi);
}





function registerSubagentRenderers(pi: ExtensionAPI) {
	// ── subagent_result message renderer ──
	pi.registerMessageRenderer("subagent_result", (message, options, theme) => {
		const details = message.details as any;
		if (!details) return undefined;

		return {
			invalidate() {},
			render(width: number): string[] {
				const name = details.name ?? "subagent";
				const exitCode = details.exitCode ?? 0;
				const errorMessage =
					typeof details.errorMessage === "string" ? details.errorMessage : "";
				const failed = exitCode !== 0 || !!errorMessage || ["error", "crashed", "recovery-failed", "cancelled"].includes(details.status);
				const needsHelp = details.kind === "help-request" || details.status === "help-request";
				const elapsed =
					details.elapsed == null ? "?" : formatElapsed(details.elapsed);
				const bgFn = (text: string) => theme.bg(failed ? "toolErrorBg" : needsHelp ? "customMessageBg" : "toolSuccessBg", text);
				const icon = failed ? theme.fg("error", "✗") : needsHelp ? theme.fg("warning", "?") : theme.fg("success", "✓");
				const status = errorMessage
					? "failed (provider/agent error)"
					: failed
						? `failed (exit ${exitCode})`
						: needsHelp ? "needs help" : "completed";
				const agentTag = details.agent
					? theme.fg("dim", ` (${details.agent})`)
					: "";

				const header = `${icon} ${theme.fg("toolTitle", theme.bold(name))}${agentTag} ${theme.fg("dim", "—")} ${status} ${theme.fg("dim", `(${elapsed})`)}`;
				const rawContent =
					typeof details.resultContent === "string"
						? details.resultContent
						: typeof message.content === "string"
							? message.content
							: "";

				// Clean summary (remove session ref and leading label for display)
				const summary = rawContent
					.replace(/\n\nSession: .+\nResume: .+$/, "")
					.replace(`Sub-agent "${name}" completed (${elapsed}).\n\n`, "")
          .replace(
            `Sub-agent "${name}" failed (exit code ${exitCode}).\n\n`,
            "",
          )
					.replace(
						new RegExp(
							`^Sub-agent "${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}" failed after ${elapsed} \\(provider/agent error — auto-retry exhausted\\)\\.\\n\\n`,
						),
						"",
					);

				// Build content for the box
				const contentLines = [header];

				if (options.expanded) {
					// Full view: complete summary + session info
					if (summary) {
						for (const line of summary.split("\n")) {
							contentLines.push(line);
						}
					}
					if (details.sessionFile) {
						contentLines.push("");
            contentLines.push(
              theme.fg("dim", `Session: ${details.sessionFile}`),
            );
						contentLines.push(
							theme.fg("dim", `Resume:  pi --session ${details.sessionFile}`),
						);
					}
				} else {
					// Collapsed: preview + expand hint
					if (summary) {
						const previewLines = summary.split("\n").slice(0, 5);
						for (const line of previewLines) {
							contentLines.push(theme.fg("dim", line.slice(0, width - 6)));
						}
						const totalLines = summary.split("\n").length;
						if (totalLines > 5) {
              contentLines.push(
                theme.fg("muted", `… ${totalLines - 5} more lines`),
              );
						}
					}
					contentLines.push(
						theme.fg("muted", keyHint("app.tools.expand", "to expand")),
					);
				}

				// Render via Box for background + padding, with blank line above for separation
				const box = new Box(1, 1, bgFn);
				box.addChild(new Text(contentLines.join("\n"), 0, 0));
				return ["", ...box.render(width)];
			},
		};
	});

	// ── subagent_status message renderer ──
	pi.registerMessageRenderer("subagent_status", (message, options, theme) => {
		const details = message.details as any;
		const lines = Array.isArray(details?.lines) ? details.lines : [];
    const overflow =
      typeof details?.overflow === "number" ? details.overflow : 0;
		if (lines.length === 0 && overflow === 0) return undefined;

		return {
			invalidate() {},
			render(width: number): string[] {
				const lineWidth = Math.max(0, width - 6);
				const contentLines = [
					`${theme.fg("accent", "•")} ${theme.fg("toolTitle", theme.bold("Subagent status"))}`,
					...lines.map((line: string) =>
						theme.fg("dim", truncateToWidth(line, lineWidth)),
					),
				];

				if (overflow > 0) {
					contentLines.push(theme.fg("muted", `+${overflow} more running.`));
				}
				if (!options.expanded) {
					contentLines.push(
						theme.fg("muted", keyHint("app.tools.expand", "to expand")),
					);
				}

				const box = new Box(1, 1, (text: string) =>
					theme.bg("customMessageBg", text),
				);
				box.addChild(new Text(contentLines.join("\n"), 0, 0));
				return ["", ...box.render(width)];
			},
		};
	});

	// ── subagent_ping message renderer ──
	pi.registerMessageRenderer("subagent_ping", (message, options, theme) => {
		const details = message.details as any;
		if (!details) return undefined;

		return {
			invalidate() {},
			render(width: number): string[] {
				const name = details.name ?? "subagent";
				const agentTag = details.agent
					? theme.fg("dim", ` (${details.agent})`)
					: "";
				const bgFn = (text: string) => theme.bg("toolSuccessBg", text);

				const icon = theme.fg("accent", "?");
				const header = `${icon} ${theme.fg("toolTitle", theme.bold(name))}${agentTag} ${theme.fg("dim", "— needs help")}`;

				const contentLines = [header];

				if (options.expanded) {
					contentLines.push("");
					contentLines.push(details.message ?? "");
					if (details.sessionFile) {
						contentLines.push("");
            contentLines.push(
              theme.fg("dim", `Session: ${details.sessionFile}`),
            );
					}
				} else {
					const preview = (details.message ?? "")
						.split("\n")[0]
						.slice(0, width - 10);
					contentLines.push(theme.fg("dim", preview));
					contentLines.push(
						theme.fg("muted", keyHint("app.tools.expand", "to expand")),
					);
				}

				const box = new Box(1, 1, bgFn);
				box.addChild(new Text(contentLines.join("\n"), 0, 0));
				return ["", ...box.render(width)];
			},
		};
	});

}
