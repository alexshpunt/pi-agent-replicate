import { readFileSync } from "node:fs";
import { basename, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Type, type Static } from "@sinclair/typebox";
import { materializeResultFile } from "./delivery-files.ts";
import { readSessionBinding } from "./session-binding.ts";
import type { SessionEntry, ReplicationContextMessage } from "./session.ts";
import { buildSessionContext } from "@earendil-works/pi-coding-agent";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

/** The fresh surface asks only for work and its expected result. */
export const ReplicateParams = Type.Object({
	task: Type.String({ minLength: 1, description: "The exact work this copy must complete and the result you expect back." }),
}, { additionalProperties: false });

/** Recovery choices are disclosed only after a result makes them relevant. */
const ReplicateRecoveryParams = Type.Object({
	...ReplicateParams.properties,
	continuation: Type.Optional(Type.String({ minLength: 1, description: "The saved copy ID supplied with a previous result." })),
	mode: Type.Optional(Type.Union([Type.Literal("resume"), Type.Literal("fork")], { description: "Continue the saved copy, or start a new copy from where it stopped." })),
}, { additionalProperties: false });
export type ReplicateRequest = Static<typeof ReplicateRecoveryParams>;

/** Keep recovery visibility scoped to the exact receiving session. */
export interface ReplicateToolControls {
	reveal(ctx: ExtensionContext): void;
}

/** Register one parallel-work tool; durable result entries restore its disclosed surface. */
export function registerReplicateTool(pi: ExtensionAPI, launch: (params: ReplicateRequest, ctx: ExtensionContext) => Promise<{ id: string; name: string; sessionFile: string }>): ReplicateToolControls {
	let recovery = false;
	let sessionId: string | undefined;
	const publish = () => pi.registerTool({
		name: "replicate", label: "Replicate",
		description: "Run a clearly defined part of your task in parallel with another copy of yourself while you continue a different part. The copy's result returns automatically to this session.",
		promptSnippet: "Run a defined part of your task in parallel with another copy of yourself while you continue a different part.",
		promptGuidelines: [
			"Use replicate only from a task-ready state: you are already in the intended working location, understand the task, and have identified independent parts that can proceed in parallel.",
			"Before calling replicate, know exactly what the copy must do, what result you expect back, and what separate work you will continue yourself.",
			"Do not replicate while still deciding the task, its scope, or where to work. Do not use it merely to hand off work.",
			"If your next action after launching a copy would be to wait for it, do the work yourself instead.",
			"After finishing your own parallel work, you may end your turn and wait for the copy's automatic result.",
			"Results arrive automatically. Do not poll for completion.",
		],
		parameters: recovery ? ReplicateRecoveryParams : ReplicateParams,
		async execute(_id, input, _signal, _update, ctx) {
			const params = input as ReplicateRequest;
			if (!params.task.trim()) throw new Error("Replication needs a nonempty task.");
			if ((params.continuation || params.mode) && (!recovery || sessionId !== ctx.sessionManager.getSessionId())) throw new Error("Recovery is not available in this session.");
			if (!!params.continuation !== !!params.mode) throw new Error("Continuation and mode must be supplied together.");
			const child = await launch(params, ctx);
			return {
				content: [{ type: "text", text: `${child.name} started. Its result will arrive here automatically.` }],
				details: { ...child, status: "running" },
			};
		},
	});
	const setRecovery = (enabled: boolean) => {
		if (recovery === enabled) return;
		recovery = enabled;
		publish();
	};
	pi.on("session_start", (_event, ctx) => {
		sessionId = ctx.sessionManager.getSessionId();
		setRecovery(ctx.sessionManager.getBranch().some((entry) => {
			const details = (entry as { details?: Record<string, unknown> }).details;
			return entry.type === "custom_message" && entry.customType === "subagent_result" && details?.replication === true && details.recoveryAvailable === true && details.receiverSessionId === sessionId;
		}));
	});
	publish();
	return { reveal(ctx) {
		sessionId = ctx.sessionManager.getSessionId();
		setRecovery(true);
	} };
}

/** Reserve a readable name and a session-owned number before asynchronous launch work. */
export function reserveReplicationName(pi: ExtensionAPI, ctx: ExtensionContext, paneTitle: () => string | undefined): string {
	// Strip control characters so a name stays on one safe terminal line.
	// oxlint-disable-next-line no-control-regex
	const clean = (value: string | undefined) => value?.replace(/[\x00-\x1f\x7f-\x9f]/g, " ").replace(/\s+/g, " ").trim();
	const base = clean(pi.getSessionName()) || clean(paneTitle()) || basename(ctx.cwd);
	const sessionId = ctx.sessionManager.getSessionId();
	let number = 0;
	for (const entry of ctx.sessionManager.getEntries()) {
		if (entry.type !== "custom" || entry.customType !== "replica_name") continue;
		const saved = entry.data as { sessionId?: string; number?: number } | undefined;
		if (saved?.sessionId === sessionId && typeof saved.number === "number" && Number.isSafeInteger(saved.number) && saved.number > number) number = saved.number;
	}
	number++;
	pi.appendEntry("replica_name", { sessionId, number });
	return `${base} · copy ${number}`;
}

/** Plain startup data captured before asynchronous launch work can observe another turn. */
export interface ReplicationSnapshot {
	entries: readonly SessionEntry[];
	contextMessages: readonly ReplicationContextMessage[];
	systemPrompt: string;
	/** Explicit extension loading flags from this Pi process. */
	extensionArgs: string[];
	/** Durable source/checkpoint record owned by this attempt. */
	recordFile?: string;
	/** Resume preserves the saved header identity but uses fresh per-attempt artifacts. */
	resumeSessionId?: string;
}

/** Use Pi's native projection, including compaction and context edits. */
export function replicationContextMessages(ctx: ExtensionContext): readonly ReplicationContextMessage[] {
	const manager = ctx.sessionManager as typeof ctx.sessionManager & {
		buildSessionProjection?: () => { messages: readonly ReplicationContextMessage[] };
	};
	return manager.buildSessionProjection?.().messages ?? buildSessionContext(manager.getBranch()).messages;
}
/** Carry explicit CLI extensions, including isolated loading, into each copy. */
export function replicationExtensionArgs(argv: readonly string[], cwd: string): string[] {
	const args: string[] = [];
	for (let i = 0; i < argv.length; i++) {
		if (argv[i] === "-ne" || argv[i] === "--no-extensions") args.push("--no-extensions");
		else if ((argv[i] === "-e" || argv[i] === "--extension") && argv[i + 1]) {
			const path = resolve(cwd, argv[++i]);
			// The fresh lifecycle goes last so inherited prompt hooks cannot append twice.
			if (path !== fileURLToPath(new URL("./subagent-done.ts", import.meta.url))) args.push("-e", path);
		}
	}
	return args;
}
/** Give the parallel copy only its bounded assignment and result requirement. */
export function replicationAssignment(task: string): string {
	return [
		"You are a parallel copy of the agent working on this task.",
		"Complete only the assignment below.",
		"Return a clear summary of the result and any unresolved issues.",
		"",
		"Your assignment:",
		task,
	].join("\n");
}

/** Save all post-fork textual answers, excluding tools, hidden reasoning and inherited answers. */
export function materializeReplicationHistory(sessionFile: string, childId: string, name: string): string {
	const binding = readSessionBinding(sessionFile);
	const baseline = binding?.child?.environment.PI_SUBAGENT_REPLICATION_ASSISTANTS;
	if (!baseline) throw new Error("Replica answer history has no inherited-answer boundary.");
	const inherited = new Set<string>(JSON.parse(baseline));
	const answers = readFileSync(sessionFile, "utf8").split("\n").filter(Boolean).flatMap((line) => {
		const entry = JSON.parse(line);
		if (entry.type !== "message" || entry.message?.role !== "assistant" || inherited.has(entry.id)) return [];
		const text = entry.message.content.filter((part: any) => part.type === "text" && typeof part.text === "string").map((part: any) => part.text).join("\n");
		return text ? [`## Answer ${entry.id}\n\n${text}`] : [];
	});
	return materializeResultFile({
		sessionsDir: dirname(sessionFile), childSessionId: childId, deliveryId: `history:${childId}`,
		status: "error", agentName: name, answer: answers.join("\n\n") || "No textual answers were produced after replication.", now: Date.now(),
	}).path;
}
