/** Validate persisted ownership without manufacturing a root for legacy records. */
export function readExecutionOwner(value) {
    if (!value || typeof value !== "object")
        return undefined;
    const owner = value;
    return typeof owner.toolCallId === "string" && !!owner.toolCallId &&
        typeof owner.parentToolCallId === "string" && !!owner.parentToolCallId
        ? { toolCallId: owner.toolCallId, parentToolCallId: owner.parentToolCallId }
        : undefined;
}
/** Capture only Pi's execution edges; callers snapshot ownership before awaiting launch. */
export function trackExecutionOwners(pi) {
    const active = new Map();
    pi.on("tool_execution_start", (event) => {
        const parent = event.parentToolCallId;
        const root = parent
            ? active.get(parent)?.parentToolCallId
            : event.toolCallId;
        if (root)
            active.set(event.toolCallId, { toolCallId: event.toolCallId, parentToolCallId: root });
    });
    pi.on("tool_execution_end", (event) => { active.delete(event.toolCallId); });
    pi.on("session_start", () => { active.clear(); });
    pi.on("session_shutdown", () => { active.clear(); });
    return (id) => active.get(id);
}
/** Stereo consumes the visible root; retain the leaf independently for provenance. */
export function linkedOutputDetails(owner) {
    return owner ? { originatingToolCallId: owner.toolCallId, parentToolCallId: owner.parentToolCallId } : {};
}
