import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Type, type Static } from "@sinclair/typebox";
import { materializeResultFile } from "./delivery-files.ts";
import { readSessionBinding } from "./session-binding.ts";
import type { SessionEntry, ReplicationContextMessage } from "./session.ts";
import { buildSessionContext } from "@earendil-works/pi-coding-agent";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

/** Register the only model-facing operation; the caller owns durable launch and supervision. */
export function registerReplicateTool(pi: ExtensionAPI, launch: (params: ReplicateRequest, ctx: ExtensionContext) => Promise<{ id: string; name: string; sessionFile: string }>): void {
	pi.registerTool({
		name: "replicate", label: "Replicate",
		description: "Create one isolated copy of your current session, runtime and working source, assigned exactly one bounded task. Successful copies attempt a host-owned join into your current source; conflicts and failures keep their saved work. To continue an owned saved result, supply its continuation ID and mode resume (same session identity) or fork (new identity). Recovery uses the latest saved state only. Worktrees isolate files, not processes, ports or databases. This call returns only a launch acknowledgement. The copy must return a final summary, which is delivered automatically to this session and starts a turn. On failure you receive error facts and a file of its textual answers. Do not poll, sleep or inspect logs to await completion. Do not assume or invent the result; continue independent work or end your turn until it arrives.",
		parameters: ReplicateParams,
		async execute(_id, params, _signal, _update, ctx) {
			if (!params.task.trim()) throw new Error("Replication needs a nonempty task.");
			if (!!params.continuation !== !!params.mode) throw new Error("Continuation and mode must be supplied together.");
			const child = await launch(params, ctx);
			return {
				content: [{ type: "text", text: `Replica ${child.name} launched. Its summary or failure will return here automatically. Continue independent work or end your turn; do not poll or assume its result.` }],
				details: { ...child, status: "running" },
			};
		},
	});
}

/** One invocation starts one isolated continuation; runtime choices are inherited. */
export const ReplicateParams = Type.Object({
	task: Type.String({ minLength: 1, description: "The exact bounded assignment for this continuation." }),
	continuation: Type.Optional(Type.String({ minLength: 1, description: "An owned continuation ID from a previous result." })),
	mode: Type.Optional(Type.Union([Type.Literal("resume"), Type.Literal("fork")], { description: "Resume the latest saved session identity, or fork it into an independent identity." })),
}, { additionalProperties: false });
export type ReplicateRequest = Static<typeof ReplicateParams>;

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
/** Keep identity and completion requirements in the task, never the system prompt. */
export function replicationAssignment(originalId: string, originalFile: string, task: string): string {
	return [
		`You are a clone of the original Pi session ${originalId}.`,
		`Original session: ${originalFile}`,
		"Work only on the assignment below, not the original's whole task. Your cwd is an isolated source-snapshot worktree. Work there; the host saves your changes and attempts integration into your immediate parent.",
		"You may use replicate for independent parts of your assignment. Wait for your own copies to finish before your final summary.",
		"Return a nonempty final summary of your result, changes, checks and any remaining limits. The runtime delivers it to your original and closes this copy automatically.",
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
