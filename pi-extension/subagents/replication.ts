import { basename, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Type, type Static } from "@sinclair/typebox";
export { materializeReplicationHistory } from "./replica-history.ts";
import type { SessionEntry, ReplicationContextMessage } from "./session.ts";
import { buildSessionContext } from "@earendil-works/pi-coding-agent";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

const namePattern = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
/** The fresh surface requires a task name and bounded work. */
export const ReplicateParams = Type.Object({
	name: Type.String({ pattern: namePattern.source, description: "A task-specific name in lowercase kebab-case, such as check-auth-risks." }),
	task: Type.String({ minLength: 1, description: "The exact work this copy must complete and the result you expect back." }),
}, { additionalProperties: false });

export type ReplicateRequest = Static<typeof ReplicateParams>;

/** Register the single fresh-copy tool without model-facing continuation controls. */
export function registerReplicateTool(pi: ExtensionAPI, launch: (params: ReplicateRequest, ctx: ExtensionContext, toolCallId: string) => Promise<{ id: string; name: string; sessionFile: string }>): void {
	pi.registerTool({
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
		parameters: ReplicateParams,
		async execute(toolCallId, input, _signal, _update, ctx) {
			const params = input as ReplicateRequest;
			if (Object.keys(params).some((key) => key !== "name" && key !== "task")) throw new Error("Replication accepts only name and task.");
			if (typeof params.name !== "string" || !namePattern.test(params.name)) throw new Error("Replication needs a lowercase kebab-case name.");
			if (typeof params.task !== "string" || !params.task.trim()) throw new Error("Replication needs a nonempty task.");
			const child = await launch(params, ctx, toolCallId);
			return {
				content: [{ type: "text", text: `${child.name} started. Its result will arrive here automatically.` }],
				details: { ...child, status: "running" },
			};
		},
	});
}

/** Add the immediate parent's readable origin to the caller's task name. */
export function replicationName(name: string, pi: ExtensionAPI, ctx: ExtensionContext, paneTitle: () => string | undefined): string {
	// Strip control characters so the origin stays on one safe terminal line.
	// oxlint-disable-next-line no-control-regex
	const clean = (value: string | undefined) => value?.replace(/[\x00-\x1f\x7f-\x9f]/g, " ").replace(/\s+/g, " ").trim();
	const origin = clean(pi.getSessionName()) || clean(paneTitle()) || clean(basename(ctx.cwd));
	return `${name} ← ${origin}`;
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
