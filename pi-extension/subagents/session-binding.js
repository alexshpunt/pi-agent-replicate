import { appendFileSync, closeSync, fsyncSync, existsSync, mkdirSync, openSync, readFileSync, readSync, readdirSync, renameSync, fstatSync, unlinkSync, writeFileSync } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { dirname, isAbsolute, join } from "node:path";
import { homedir } from "node:os";
import { getPaneProcessInfo } from "./terminal.js";
export const SESSION_BINDING_TYPE = "subagent-session-binding";
/** Bind the freshly opened context and restore only session-owned child settings. */
export function bindSessionRuntime(pi, ctx) {
    const manager = ctx.sessionManager;
    const sessionFile = manager?.getSessionFile?.();
    const sessionId = manager?.getSessionId?.();
    if (!sessionFile || !sessionId)
        return undefined;
    let binding = readSessionBinding(sessionFile);
    if (!binding) {
        binding = { version: 1, sessionId, storeDir: sessionBindingStore() };
        pi.appendEntry(SESSION_BINDING_TYPE, binding);
    }
    if (binding.child) {
        for (const [key, value] of Object.entries(binding.child.environment)) {
            if ((key.startsWith("PI_SUBAGENT_") || key === "PI_DENY_TOOLS") && typeof value === "string")
                process.env[key] = value;
        }
        process.env.PI_SUBAGENT_SESSION = sessionFile;
        process.env.PI_SUBAGENT_LAUNCHER_PID = String(process.ppid);
        process.env.PI_SUBAGENT_SURFACE = process.env.HERDR_PANE_ID;
    }
    let shellPid;
    try {
        if (process.env.HERDR_PANE_ID)
            shellPid = getPaneProcessInfo(process.env.HERDR_PANE_ID).shellPid;
    }
    catch { /* No verified pane means no destructive cleanup. */ }
    publishSessionLocation(binding, {
        shellPid, shellStart: shellPid ? startTime(shellPid) : undefined,
        serverPid: shellPid ? parentPid(shellPid) : undefined,
        serverStart: shellPid && parentPid(shellPid) ? startTime(parentPid(shellPid)) : undefined,
        sessionFile, cwd: ctx.cwd,
        paneId: process.env.HERDR_PANE_ID,
        tabId: process.env.HERDR_TAB_ID,
        workspaceId: process.env.HERDR_WORKSPACE_ID,
    });
    return binding;
}
/** Atomically save state and sync both its bytes and directory before returning. */
export function writeBindingFile(path, value) {
    mkdirSync(dirname(path), { recursive: true });
    const temporary = `${path}.${randomUUID()}.tmp`;
    let fd;
    try {
        fd = openSync(temporary, "wx", 0o600);
        writeFileSync(fd, JSON.stringify(value));
        fsyncSync(fd);
        closeSync(fd);
        fd = undefined;
        renameSync(temporary, path);
        const directory = openSync(dirname(path), "r");
        try {
            fsyncSync(directory);
        }
        finally {
            closeSync(directory);
        }
    }
    finally {
        if (fd !== undefined)
            closeSync(fd);
        try {
            unlinkSync(temporary);
        }
        catch { /* Already published or not created. */ }
    }
}
function readJson(path) {
    try {
        return JSON.parse(readFileSync(path, "utf8"));
    }
    catch {
        return undefined;
    }
}
// Bound memory to observed sessions, not the full conversation or session directory.
const bindingCursors = new Map();
const READ_CHUNK = 4096;
function readHeader(fd) {
    const chunks = [];
    for (let position = 0; position < 64 * 1024; position += READ_CHUNK) {
        const buffer = Buffer.allocUnsafe(READ_CHUNK);
        const count = readSync(fd, buffer, 0, buffer.length, position);
        const newline = buffer.subarray(0, count).indexOf(10);
        chunks.push(buffer.subarray(0, newline < 0 ? count : newline));
        if (newline >= 0 || count < READ_CHUNK) {
            const header = JSON.parse(Buffer.concat(chunks).toString("utf8"));
            return header.type === "session" && typeof header.id === "string" ? header : undefined;
        }
    }
    return undefined;
}
/** Read only the session header, never the conversation that follows it. */
export function readSessionHeader(sessionFile) {
    let fd;
    try {
        fd = openSync(sessionFile, "r");
        return readHeader(fd);
    }
    catch {
        return undefined;
    }
    finally {
        if (fd !== undefined)
            closeSync(fd);
    }
}
function readBoundary(fd, size) {
    const buffer = Buffer.alloc(Math.min(64, size));
    const count = readSync(fd, buffer, 0, buffer.length, size - buffer.length);
    return buffer.subarray(0, count);
}
function bindingRecordUnchanged(fd, cursor) {
    if (!cursor.record)
        return true;
    const buffer = Buffer.alloc(cursor.record.bytes.length);
    return readSync(fd, buffer, 0, buffer.length, cursor.record.offset) === buffer.length && buffer.equals(cursor.record.bytes);
}
/** Read complete appended binding records, validating ownership against the current header. */
export function readSessionBinding(sessionFile) {
    let fd;
    try {
        fd = openSync(sessionFile, "r");
        // Keep identity and records on one opened file if the path is replaced.
        const stat = fstatSync(fd);
        const previous = bindingCursors.get(sessionFile);
        if (previous && previous.dev === stat.dev && previous.ino === stat.ino && previous.size === stat.size && previous.mtimeMs === stat.mtimeMs && previous.ctimeMs === stat.ctimeMs) {
            return previous.binding && structuredClone(previous.binding);
        }
        const header = readHeader(fd);
        if (!header) {
            bindingCursors.delete(sessionFile);
            return undefined;
        }
        // A replaced, truncated or rewritten journal must not retain cached ownership.
        const append = previous && previous.dev === stat.dev && previous.ino === stat.ino && previous.sessionId === header.id && stat.size > previous.size && readBoundary(fd, previous.size).equals(previous.boundary) && bindingRecordUnchanged(fd, previous);
        const cursor = append ? previous : {
            dev: stat.dev, ino: stat.ino, size: 0, mtimeMs: 0, ctimeMs: 0,
            sessionId: header.id, boundary: Buffer.alloc(0), pending: [], lineStart: 0,
        };
        let position = cursor.size;
        while (position < stat.size) {
            const buffer = Buffer.allocUnsafe(Math.min(64 * 1024, stat.size - position));
            const count = readSync(fd, buffer, 0, buffer.length, position);
            if (!count)
                break;
            let start = 0;
            for (let index = 0; index < count; index++) {
                if (buffer[index] !== 10)
                    continue;
                cursor.pending.push(buffer.subarray(start, index));
                const line = Buffer.concat(cursor.pending).toString("utf8");
                const lineStart = cursor.lineStart;
                cursor.lineStart = position + index + 1;
                cursor.pending = [];
                start = index + 1;
                if (!line.includes(SESSION_BINDING_TYPE))
                    continue;
                try {
                    const row = JSON.parse(line), binding = row.data;
                    if (row.type !== "custom" || row.customType !== SESSION_BINDING_TYPE)
                        continue;
                    if (binding?.version !== 1 || binding.sessionId !== header.id || typeof binding.storeDir !== "string" || !isAbsolute(binding.storeDir))
                        continue;
                    if (binding.child && (!binding.child.lineage?.rootDir || !binding.child.lineage?.nodeId || !binding.child.environment))
                        continue;
                    cursor.binding = binding;
                    cursor.record = { offset: lineStart, bytes: Buffer.from(line + "\n") };
                }
                catch { /* Ignore malformed complete records, as before. */ }
            }
            if (start < count)
                cursor.pending.push(buffer.subarray(start, count));
            position += count;
        }
        cursor.size = position;
        cursor.mtimeMs = stat.mtimeMs;
        cursor.ctimeMs = stat.ctimeMs;
        cursor.boundary = readBoundary(fd, position);
        bindingCursors.delete(sessionFile);
        bindingCursors.set(sessionFile, cursor);
        if (bindingCursors.size > 128)
            bindingCursors.delete(bindingCursors.keys().next().value);
        return cursor.binding && structuredClone(cursor.binding);
    }
    catch {
        bindingCursors.delete(sessionFile);
        return undefined;
    }
    finally {
        if (fd !== undefined)
            closeSync(fd);
    }
}
/** Use the store carried by the session, even when it moved to another agent directory. */
export function sessionBindingStore(sessionFile, agentDir) {
    return (sessionFile ? readSessionBinding(sessionFile)?.storeDir : undefined)
        ?? join(agentDir ?? process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent"), "subagent-sessions");
}
function ownerDir(storeDir, sessionId) {
    return join(storeDir, "owners", encodeURIComponent(sessionId));
}
/** Index each lineage independently so simultaneous launches cannot overwrite siblings. */
export function registerSessionLineage(storeDir, sessionId, rootDir) {
    writeBindingFile(join(ownerDir(storeDir, sessionId), `${createHash("sha256").update(rootDir).digest("hex")}.json`), { version: 1, sessionId, rootDir });
}
/** Find ownership by the durable session key, not the current cwd or file path. */
export function sessionLineageRoots(storeDir, sessionId) {
    const directory = ownerDir(storeDir, sessionId);
    let names;
    try {
        names = readdirSync(directory);
    }
    catch {
        return [];
    }
    return names.filter((name) => name.endsWith(".json")).flatMap((name) => {
        const record = readJson(join(directory, name));
        return record?.version === 1 && record.sessionId === sessionId && typeof record.rootDir === "string" && isAbsolute(record.rootDir) ? [record.rootDir] : [];
    });
}
/** Seed child identity before starting Pi. A running session must use pi.appendEntry instead. */
export function seedSessionBinding(sessionFile, binding) {
    const raw = readFileSync(sessionFile, "utf8");
    const rows = raw.trim().split("\n").map((line) => JSON.parse(line));
    const header = rows[0];
    if (header.type !== "session" || typeof header.id !== "string")
        throw new Error("Cannot bind a child without a session header");
    const data = { ...binding, sessionId: header.id };
    appendFileSync(sessionFile, JSON.stringify({ type: "custom", id: randomUUID(), parentId: rows.at(-1)?.id ?? null, timestamp: new Date().toISOString(), customType: SESSION_BINDING_TYPE, data }) + "\n");
    const fd = openSync(sessionFile, "r");
    try {
        fsyncSync(fd);
    }
    finally {
        closeSync(fd);
    }
    return data;
}
function parentPid(pid) {
    try {
        const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
        return Number(stat.slice(stat.lastIndexOf(")") + 2).split(/\s+/)[1]) || undefined;
    }
    catch {
        return undefined;
    }
}
function startTime(pid) {
    try {
        const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
        return stat.slice(stat.lastIndexOf(")") + 2).split(/\s+/)[19];
    }
    catch {
        return undefined;
    }
}
/** Publish one startup's exact file and pane, surviving both Teleport and Herdr restarts. */
export function publishSessionLocation(binding, input) {
    const location = {
        version: 1, sessionId: binding.sessionId, ...input, pid: process.pid, processStart: startTime(process.pid),
        ...(binding.child ? { childNodeId: binding.child.lineage.nodeId, childRootDir: binding.child.lineage.rootDir } : {}),
    };
    writeBindingFile(join(binding.storeDir, "locations", `${encodeURIComponent(binding.sessionId)}.json`), location);
    if (binding.child)
        writeBindingFile(join(binding.child.lineage.rootDir, "locations", `${encodeURIComponent(binding.child.lineage.nodeId)}.json`), location);
    return location;
}
/** Hold child completion while Teleport starts a replacement, with a bounded failure gate. */
export function beginChildSessionMove(binding) {
    if (!binding.child)
        return;
    const path = join(binding.child.lineage.rootDir, "locations", `${encodeURIComponent(binding.child.lineage.nodeId)}.json`);
    const location = readJson(path);
    if (validLocation(location) && location.pid === process.pid)
        writeBindingFile(path, { ...location, moveDeadline: Date.now() + 15_000 });
}
/** A dead process still supplies a recoverable saved location, never a live receiver. */
export function sessionLocationAlive(location) {
    try {
        process.kill(location.pid, 0);
    }
    catch {
        return false;
    }
    return location.processStart !== undefined && startTime(location.pid) === location.processStart;
}
/** A lost pane is not a user cancellation when its Herdr incarnation also died. */
export function sessionServerAlive(location) {
    if (!location.serverPid || !location.serverStart)
        return undefined;
    return startTime(location.serverPid) === location.serverStart;
}
/** Allow pane cleanup only while its original shell incarnation still owns it. */
export function sessionOwnsPane(location, paneId, shellPid) {
    return location.paneId === paneId && location.shellPid === shellPid && shellPid !== undefined
        && location.shellStart !== undefined && startTime(shellPid) === location.shellStart;
}
function validLocation(value) {
    return value?.version === 1 && typeof value.sessionId === "string" && typeof value.sessionFile === "string" && isAbsolute(value.sessionFile) && Number.isInteger(value.pid) && value.pid > 0 && typeof value.cwd === "string";
}
/** Resolve the last registered incarnation of a child. */
export function childSessionLocation(rootDir, nodeId) {
    const value = readJson(join(rootDir, "locations", `${encodeURIComponent(nodeId)}.json`));
    if (!validLocation(value))
        return undefined;
    const binding = readSessionBinding(value.sessionFile);
    if (binding?.child?.lineage.rootDir === rootDir && binding.child.lineage.nodeId === nodeId)
        return value;
    // Teleport may remove the source before the replacement finishes extension startup.
    if (value.childRootDir === rootDir && value.childNodeId === nodeId && !existsSync(value.sessionFile))
        return value;
    return undefined;
}
/** Resolve a parent with matching session evidence; a copied branch is not a receiver. */
export function parentSessionLocation(storeDir, sessionId) {
    const value = readJson(join(storeDir, "locations", `${encodeURIComponent(sessionId)}.json`));
    if (!validLocation(value) || value.sessionId !== sessionId)
        return undefined;
    return readSessionHeader(value.sessionFile)?.id === sessionId ? value : undefined;
}
