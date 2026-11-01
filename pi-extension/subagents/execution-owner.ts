import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/** Actual attempt execution and its visible outer tool call, never inferred from IDs. */
export interface ExecutionOwner {
	toolCallId: string;
	parentToolCallId: string;
}

/** Validate persisted ownership without manufacturing a root for legacy records. */
export function readExecutionOwner(value: unknown): ExecutionOwner | undefined {
	if (!value || typeof value !== "object") return undefined;
	const owner = value as Partial<ExecutionOwner>;
	return typeof owner.toolCallId === "string" && !!owner.toolCallId &&
		typeof owner.parentToolCallId === "string" && !!owner.parentToolCallId
		? { toolCallId: owner.toolCallId, parentToolCallId: owner.parentToolCallId }
		: undefined;
}

/** Capture only Pi's execution edges; callers snapshot ownership before awaiting launch. */
export function trackExecutionOwners(pi: ExtensionAPI): (id: string) => ExecutionOwner | undefined {
	const active = new Map<string, ExecutionOwner>();
	pi.on("tool_execution_start", (event) => {
		const parent = (event as typeof event & { parentToolCallId?: string }).parentToolCallId;
		const root = parent
			? active.get(parent)?.parentToolCallId
			: event.toolCallId;
		if (root) active.set(event.toolCallId, { toolCallId: event.toolCallId, parentToolCallId: root });
	});
	pi.on("tool_execution_end", (event) => { active.delete(event.toolCallId); });
	pi.on("session_start", () => { active.clear(); });
	pi.on("session_shutdown", () => { active.clear(); });
	return (id) => active.get(id);
}

/** Stereo consumes the visible root; retain the leaf independently for provenance. */
export function linkedOutputDetails(owner: ExecutionOwner | undefined): Record<string, string> {
	return owner ? { originatingToolCallId: owner.toolCallId, parentToolCallId: owner.parentToolCallId } : {};
}
