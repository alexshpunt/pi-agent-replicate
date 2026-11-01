import { readFileSync } from "node:fs";
import { dirname } from "node:path";
import { materializeResultFile } from "./delivery-files.ts";
import { readSessionBinding } from "./session-binding.ts";

/** Save post-fork answer text without inherited answers, tools or hidden reasoning. */
export function materializeReplicationHistory(sessionFile: string, childId: string, name: string): string {
	const baseline = readSessionBinding(sessionFile)?.child?.environment.PI_SUBAGENT_REPLICATION_ASSISTANTS;
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
