import { basename, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Type, type Static } from "@sinclair/typebox";
export { materializeReplicationHistory } from "./replica-history.ts";
import type { SessionEntry, ReplicationContextMessage } from "./session.ts";
import type { ReplicaWork } from "./replica-work.ts";
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
export function registerReplicateTool(pi: ExtensionAPI, launch: (params: ReplicateRequest, ctx: ExtensionContext, toolCallId: string) => Promise<{ id: string; name: string; sessionFile: string; worktreePath?: string; branch?: string }>): void {
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
				content: [{ type: "text", text: replicationStarted(child, ctx.cwd) }],
				details: { ...child, status: "running" },
			};
		},
	});
}

/** Name where the copy works, so its result can be traced back to a location. */
function replicationStarted(child: { name: string; worktreePath?: string; branch?: string }, cwd: string | undefined): string {
	if (child.worktreePath) {
		const branch = child.branch ? ` on branch ${child.branch}` : "";
		return `${child.name} started in its own worktree ${child.worktreePath}${branch}. Its result will arrive here automatically; when it succeeds, its changes are applied to your working directory.`;
	}
	return `${child.name} started${cwd ? ` in your directory ${cwd}` : ""}. Its result will arrive here automatically.`;
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
/** Give the parallel copy its bounded assignment, where its changes go and its result requirement. */
export function replicationAssignment(task: string, mode: "worktree" | "shared"): string {
	return [
		"You are a parallel copy of the agent working on this task.",
		"Complete only the assignment below.",
		mode === "worktree"
			? "You work in your own copy of the files. When you finish successfully, your changes, committed or not, are applied to the original agent's working directory automatically; do not copy them there yourself."
			: "You work in the original agent's directory, and it sees your changes immediately.",
		"Return a clear summary of the result and any unresolved issues.",
		"",
		"Your assignment:",
		task,
	].join("\n");
}

const reportedPathLimit = 20;
/** Tell the parent where the copy's changes are now, so it never looks for them in a removed checkout. */
export function replicaWorkReport(work: Pick<ReplicaWork, "mode" | "integration" | "joinPlan" | "worktree">, failed: boolean): string {
	if (work.mode === "shared") return failed ? "The copy worked in the shared directory; partial changes may already be present." : "";
	const kept = work.worktree ? ` Its work, including uncommitted changes, is kept in ${work.worktree.path} on branch ${work.worktree.branch}.` : "";
	switch (work.integration.status) {
		case "applied": {
			const paths = work.joinPlan?.paths;
			if (!paths) return "Its changes were applied to your working directory and are not committed.";
			if (!paths.length) return "It had no file changes to apply to your working directory.";
			const more = paths.length - reportedPathLimit;
			return `Its changes were applied to your working directory and are not committed: ${paths.slice(0, reportedPathLimit).join(", ")}${more > 0 ? `, and ${more} more` : ""}.`;
		}
		case "conflict": return `The copy finished, but its changes conflict with your current work and were not included.${kept}`;
		case "not-attempted": return `The copy's unfinished work was not included in your work.${kept}`;
		default: return `The copy finished, but its changes could not be safely included in your work.${kept}`;
	}
}
