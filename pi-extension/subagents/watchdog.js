import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, writeSync, } from "node:fs";
import { dirname } from "node:path";
export const DEFAULT_QUIET_THRESHOLD_MS = 120_000;
export const MAX_RECOVERY_ATTEMPTS = 3;
export const REPLICA_STOP_GRACE_MS = 10_000;
/** A stopped replica gets a safety net, never an inactivity-based relaunch. */
export function replicaStopDue(input) {
    return input.idleSince !== undefined && input.idle && !input.pendingMessages &&
        !input.moving && !input.descendants && input.now - input.idleSince >= REPLICA_STOP_GRACE_MS;
}
/** Resolve the watchdog threshold with environment precedence and strict validation. */
export function resolveQuietThreshold(envValue, configuredValue) {
    if (envValue !== undefined) {
        const parsed = Number(envValue);
        if (!Number.isInteger(parsed) || parsed <= 0) {
            throw new Error("Invalid PI_SUBAGENT_QUIET_THRESHOLD_MS: expected a positive integer");
        }
        return parsed;
    }
    if (configuredValue !== undefined) {
        if (!Number.isInteger(configuredValue) || configuredValue <= 0) {
            throw new Error("Invalid status.quietThresholdMs: expected a positive integer");
        }
        return configuredValue;
    }
    return DEFAULT_QUIET_THRESHOLD_MS;
}
/** Classify observable inactivity without bounding tools, streams, or descendant drain. */
export function classifyStaleness(input) {
    if (!input.autonomous)
        return "active";
    if (input.waitingForDescendants)
        return "waiting";
    if (input.activity?.compactionActive)
        return "active";
    if (input.activity?.toolActive)
        return "active";
    if (input.descendantActivityAt !== undefined && input.activity?.providerActive)
        return "active";
    const lastEventAt = Math.max(input.activity?.updatedAt ?? input.startedAt, input.descendantActivityAt ?? 0);
    return input.now - lastEventAt > input.quietThresholdMs ? "stale" : "active";
}
function records(logPath, childId) {
    if (!existsSync(logPath))
        return [];
    return readFileSync(logPath, "utf8")
        .split("\n")
        .filter(Boolean)
        .map((line, index) => {
        try {
            return JSON.parse(line);
        }
        catch (error) {
            throw new Error(`Invalid recovery ledger record ${index + 1} in ${logPath}`, { cause: error });
        }
    })
        .filter((record) => record.event === "recovery-attempt" && record.childId === childId);
}
function appendRecoveryRecord(logPath, record) {
    mkdirSync(dirname(logPath), { recursive: true });
    const descriptor = openSync(logPath, "a");
    try {
        writeSync(descriptor, `${JSON.stringify(record)}\n`, undefined, "utf8");
        fsyncSync(descriptor);
    }
    finally {
        closeSync(descriptor);
    }
}
/**
 * Decide whether the parent watchdog may supervise one child as stale.
 *
 * An exhausted recovery budget is final: the child cannot be resumed again, so
 * another stale pass would only repeat the same kill attempt forever.
 */
export function shouldStartStaleRecovery(input) {
    if (input.interactive)
        return false;
    if (input.pendingTerminalDelivery)
        return false;
    if (input.recoveryAttemptActive)
        return false;
    if (input.recoveryExhausted)
        return false;
    return true;
}
/** Consume one durable attempt from the shared crash-and-stale recovery budget. */
export function consumeRecoveryAttempt(input) {
    const previous = records(input.logPath, input.childId);
    const attemptedCauses = previous
        .map((record) => record.cause)
        .filter((cause) => cause === "crash" || cause === "stale");
    const reasonFor = (causes) => {
        if (new Set(causes).size > 1)
            return "Recovery failed after mixed crash and stale attempts.";
        return causes[0] === "crash"
            ? "Recovery failed after repeated child process crashes."
            : "Recovery failed after repeated stale watchdog kills.";
    };
    if (previous.length >= MAX_RECOVERY_ATTEMPTS) {
        return {
            attempt: MAX_RECOVERY_ATTEMPTS,
            exhausted: true,
            reason: reasonFor(attemptedCauses),
        };
    }
    const attempt = previous.length + 1;
    const now = input.now ?? Date.now;
    appendRecoveryRecord(input.logPath, {
        version: 1,
        time: new Date(now()).toISOString(),
        event: "recovery-attempt",
        childId: input.childId,
        attempt,
        cause: input.cause,
    });
    return {
        attempt,
        exhausted: false,
        reason: reasonFor([...attemptedCauses, input.cause]),
    };
}
