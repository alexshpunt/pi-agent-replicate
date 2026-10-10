import { appendFileSync, copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync, } from "node:fs";
import { randomBytes, randomUUID } from "node:crypto";
import { dirname, join } from "node:path";
export function seedStandaloneSessionFile(params) {
    const header = {
        type: "session",
        version: 3,
        id: randomUUID(),
        timestamp: new Date().toISOString(),
        cwd: params.childCwd,
    };
    mkdirSync(dirname(params.childSessionFile), { recursive: true });
    writeFileSync(params.childSessionFile, `${JSON.stringify(header)}\n`, "utf8");
}
function getForkContentLines(parentSessionFile) {
    const raw = readFileSync(parentSessionFile, "utf8");
    const lines = raw.split("\n").filter((line) => line.trim());
    let truncateAt = lines.length;
    for (let i = lines.length - 1; i >= 0; i--) {
        try {
            const entry = JSON.parse(lines[i]);
            if (entry.type === "message" && entry.message?.role === "user") {
                truncateAt = i;
                break;
            }
        }
        catch {
            // ignore malformed lines
        }
    }
    return lines.slice(0, truncateAt).filter((line) => {
        try {
            return JSON.parse(line).type !== "session";
        }
        catch {
            return true;
        }
    });
}
export function seedSubagentSessionFile(params) {
    const header = {
        type: "session",
        version: 3,
        id: randomUUID(),
        timestamp: new Date().toISOString(),
        cwd: params.childCwd,
        parentSession: params.parentSessionFile,
    };
    const contentLines = params.mode === "fork" ? getForkContentLines(params.parentSessionFile) : [];
    const lines = [JSON.stringify(header), ...contentLines];
    mkdirSync(dirname(params.childSessionFile), { recursive: true });
    writeFileSync(params.childSessionFile, lines.join("\n") + "\n", "utf8");
}
/** Fork the captured active branch and settle inherited calls without running them again. */
export function seedReplicationSessionFile(params) {
    const header = { type: "session", version: 3, id: params.resumeSessionId ?? randomUUID(), timestamp: new Date().toISOString(), cwd: params.childCwd, parentSession: params.parentSessionFile };
    const rows = [header];
    const pending = new Map();
    let parentId = null;
    for (const source of params.entries) {
        const entry = { ...source, parentId };
        rows.push(entry);
        parentId = entry.id;
    }
    // Use the native projected context, not raw history before compaction or edits.
    for (const message of params.contextMessages) {
        if (message.role === "system")
            continue;
        if (message.role === "toolResult") {
            pending.delete(message.toolCallId);
            continue;
        }
        // A later turn already closes older orphan calls during provider replay.
        pending.clear();
        if (message.role !== "assistant" || message.stopReason === "error" || message.stopReason === "aborted")
            continue;
        for (const part of message.content)
            if (part.type === "toolCall")
                pending.set(part.id, part.name);
    }
    for (const [toolCallId, toolName] of pending) {
        const id = randomBytes(4).toString("hex");
        rows.push({ type: "message", id, parentId, timestamp: new Date().toISOString(), message: {
                role: "toolResult", toolCallId, toolName, isError: false, timestamp: Date.now(),
                content: [{ type: "text", text: "This call belongs to the original session. This copy continues with its own assignment." }],
            } });
        parentId = id;
    }
    mkdirSync(dirname(params.childSessionFile), { recursive: true });
    writeFileSync(params.childSessionFile, rows.map((row) => JSON.stringify(row)).join("\n") + "\n", "utf8");
}
function parseEntry(line) {
    try {
        return JSON.parse(line);
    }
    catch (error) {
        throw new Error(`Invalid session entry: ${error instanceof Error ? error.message : String(error)}`);
    }
}
function readEntries(sessionFile) {
    return readFileSync(sessionFile, "utf8")
        .split("\n")
        .filter((line) => line.trim())
        .map(parseEntry);
}
/**
 * Read a session while ignoring one incomplete final JSONL record.
 *
 * Pi writes session entries atomically in normal operation, but a parent can
 * observe the file between the write and the trailing newline. The next poll
 * can read the same entry once it is complete, so the incomplete record is
 * deliberately reported rather than treated as a session error.
 */
function readEntriesTolerant(sessionFile) {
    if (!existsSync(sessionFile)) {
        return { entries: [], partialTrailingLine: false };
    }
    const lines = readFileSync(sessionFile, "utf8")
        .split("\n")
        .filter((line) => line.trim());
    const entries = [];
    let partialTrailingLine = false;
    for (let index = 0; index < lines.length; index++) {
        try {
            entries.push(parseEntry(lines[index]));
        }
        catch (error) {
            if (index === lines.length - 1) {
                partialTrailingLine = true;
                continue;
            }
            throw error;
        }
    }
    return { entries, partialTrailingLine };
}
/** Capture the session position and inherited assistant ids before a run. */
export function captureSessionBaseline(sessionFile) {
    const { entries } = readEntriesTolerant(sessionFile);
    return {
        sessionFile,
        entryCount: entries.length,
        leafId: entries.length > 0 ? entries[entries.length - 1].id : null,
        assistantEntryIds: entries
            .filter((entry) => entry.type === "message" &&
            entry.message.role === "assistant")
            .map((entry) => entry.id),
    };
}
/** Read only records appended after a pre-run session baseline. */
export function readEntriesAfterBaseline(sessionFile, baseline) {
    const read = readEntriesTolerant(sessionFile);
    return {
        entries: read.entries.slice(baseline.entryCount),
        partialTrailingLine: read.partialTrailingLine,
    };
}
/** Return the newest assistant entry in a post-baseline append. */
export function findNewestAppendedAssistant(entries) {
    for (let index = entries.length - 1; index >= 0; index--) {
        const entry = entries[index];
        if (entry.type !== "message")
            continue;
        const message = entry.message;
        if (message.role !== "assistant")
            continue;
        const textBlocks = message.content.filter((block) => block.type === "text" && typeof block.text === "string");
        const text = textBlocks.map((block) => block.text).join("\n");
        const stopReason = message.stopReason;
        const errorMessage = message.errorMessage;
        return {
            id: entry.id,
            text: text.trim() ? text : null,
            contentLength: text.length,
            empty: !text.trim(),
            ...(typeof stopReason === "string" ? { stopReason } : {}),
            ...(typeof errorMessage === "string" && errorMessage.trim()
                ? { errorMessage: errorMessage.trim() }
                : {}),
        };
    }
    return null;
}
/** Read and inspect the newest assistant appended after a child baseline. */
export function inspectNewestAppendedAssistant(sessionFile, baseline) {
    return findNewestAppendedAssistant(readEntriesAfterBaseline(sessionFile, baseline).entries);
}
/**
 * Return the id of the last entry in the session file (current branch point / leaf).
 */
export function getLeafId(sessionFile) {
    const entries = readEntries(sessionFile);
    return entries.length > 0 ? entries[entries.length - 1].id : null;
}
/**
 * Return entries added after `afterLine` (1-indexed count of existing entries).
 */
export function getNewEntries(sessionFile, afterLine) {
    return readFileSync(sessionFile, "utf8")
        .split("\n")
        .filter((line) => line.trim())
        .slice(afterLine)
        .map(parseEntry);
}
/** Read the effective model and thinking entries recorded by Pi at session startup. */
export function findObservedSessionRuntime(entries) {
    const observed = {};
    for (const entry of entries) {
        if (entry.type === "model_change") {
            if (typeof entry.provider === "string")
                observed.provider = entry.provider;
            if (typeof entry.modelId === "string")
                observed.modelId = entry.modelId;
        }
        else if (entry.type === "thinking_level_change" &&
            typeof entry.thinkingLevel === "string") {
            observed.thinking = entry.thinkingLevel;
        }
    }
    return observed;
}
/** Inspect only the final assistant message for completion evidence. */
export function inspectFinalAssistantMessage(entries) {
    for (let i = entries.length - 1; i >= 0; i--) {
        const entry = entries[i];
        if (entry.type !== "message")
            continue;
        const msg = entry;
        if (msg.message.role !== "assistant")
            continue;
        const texts = msg.message.content
            .filter((block) => block.type === "text" && typeof block.text === "string")
            .map((block) => block.text);
        const text = texts.join("\n");
        const stopReason = msg.message.stopReason;
        return {
            text: text.trim() ? text : null,
            contentLength: text.length,
            ...(typeof stopReason === "string" ? { stopReason } : {}),
        };
    }
    return { text: null, contentLength: 0 };
}
export function findLastAssistantMessage(entries) {
    for (let i = entries.length - 1; i >= 0; i--) {
        const entry = entries[i];
        if (entry.type !== "message")
            continue;
        const msg = entry;
        if (msg.message.role !== "assistant")
            continue;
        const texts = msg.message.content
            .filter((block) => block.type === "text" &&
            typeof block.text === "string" &&
            block.text.trim() !== "")
            .map((block) => block.text);
        if (texts.length > 0 && texts.join("").trim())
            return texts.join("\n");
        const stopReason = msg.message.stopReason;
        const errorMessage = msg.message
            .errorMessage;
        if (stopReason === "error" &&
            typeof errorMessage === "string" &&
            errorMessage.trim() !== "") {
            return `Subagent error: ${errorMessage.trim()}`;
        }
    }
    return null;
}
/**
 * Append a branch_summary entry to the session file.
 * Returns the new entry's id.
 */
export function appendBranchSummary(sessionFile, branchPointId, fromId, summary) {
    const id = randomBytes(4).toString("hex");
    const entry = {
        type: "branch_summary",
        id,
        parentId: branchPointId,
        timestamp: new Date().toISOString(),
        fromId: fromId ?? branchPointId,
        summary,
    };
    appendFileSync(sessionFile, JSON.stringify(entry) + "\n", "utf8");
    return id;
}
/**
 * Copy the session file to destDir for parallel worker isolation.
 * Returns the path of the copy.
 */
export function copySessionFile(sessionFile, destDir) {
    const id = randomBytes(4).toString("hex");
    const dest = join(destDir, `subagent-${id}.jsonl`);
    copyFileSync(sessionFile, dest);
    return dest;
}
/**
 * Read new entries from sourceFile (after afterLine), append them to targetFile.
 * Returns the appended entries.
 */
export function mergeNewEntries(sourceFile, targetFile, afterLine) {
    const entries = getNewEntries(sourceFile, afterLine);
    for (const entry of entries) {
        appendFileSync(targetFile, JSON.stringify(entry) + "\n", "utf8");
    }
    return entries;
}
