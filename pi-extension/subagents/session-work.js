import { readFile } from "node:fs/promises";
const record = (value) => value !== null && typeof value === "object" && !Array.isArray(value) ? value : undefined;
/** Work receipts belong to this session, not inherited conversation or the terminal host. */
export class SessionWork {
    tools = new Set();
    terminals = new Set();
    requests = new Set();
    searches = new Set();
    searchWaits = new Map();
    completedTerminals = new Set();
    completedRequests = new Set();
    processes = new Map();
    sessionId;
    constructor(sessionId, saved) {
        this.sessionId = sessionId;
        if (saved?.sessionId !== sessionId)
            return;
        for (const source of saved.terminals ?? [])
            if (typeof source === "string")
                this.terminals.add(source);
        for (const id of saved.requests ?? [])
            if (typeof id === "string")
                this.requests.add(id);
        for (const id of saved.searches ?? [])
            if (this.requests.has(id))
                this.searches.add(id);
        for (const identity of saved.processes ?? [])
            if (Number.isInteger(identity.pid) && identity.pid > 0 && typeof identity.start === "string" && typeof identity.boot === "string")
                this.processes.set(identity.pid, identity);
    }
    get pending() { return this.tools.size + this.terminals.size + this.requests.size + this.processes.size > 0; }
    snapshot() { return { sessionId: this.sessionId, terminals: [...this.terminals], requests: [...this.requests], searches: [...this.searches].filter(id => this.requests.has(id)), processes: [...this.processes.values()] }; }
    toolStarted(id, toolName) {
        this.tools.add(id);
        if (toolName === "wait_for_web_searches")
            this.searchWaits.set(id, new Set(this.searches));
    }
    toolEnded(id) { this.tools.delete(id); this.searchWaits.delete(id); }
    toolResult(value, inspection = false, toolName, toolCallId) {
        const data = record(value);
        if (inspection && data?.origin?.sessionId !== this.sessionId)
            return;
        if (!data || data.origin?.sessionId && data.origin.sessionId !== this.sessionId)
            return;
        // A successful wait drains its start-time search set, including searches
        // cancelled by a provider retry. Other requests and later launches stay owned.
        if (toolName === "wait_for_web_searches" && Array.isArray(data.results) && toolCallId) {
            for (const id of this.searchWaits.get(toolCallId) ?? []) {
                this.completedRequests.add(id);
                this.requests.delete(id);
                this.searches.delete(id);
            }
        }
        if (typeof data.source === "string" && data.source.startsWith("shell:") && !this.completedTerminals.has(data.source) && ["running", "stopping"].includes(data.status))
            this.terminals.add(data.source);
        if (typeof data.requestId === "string") {
            if (toolName === "web_search" && ["running", "queued"].includes(data.status) && !this.completedRequests.has(data.requestId))
                this.searches.add(data.requestId);
            if (["completed", "failed", "cancelled"].includes(data.status) || data.answers !== undefined) {
                this.completedRequests.add(data.requestId);
                this.requests.delete(data.requestId);
            }
            else if (!this.completedRequests.has(data.requestId) && ["running", "queued"].includes(data.status))
                this.requests.add(data.requestId);
        }
    }
    /** Completion arrival invalidates an old final answer; Pi processes the message normally. */
    message(value) {
        const message = record(value);
        if (!message)
            return false;
        let changed = false;
        if (message.customType === "terminal-completion") {
            for (const session of message.details?.sessions ?? []) {
                if (session.origin?.sessionId && session.origin.sessionId !== this.sessionId)
                    continue;
                this.completedTerminals.add(session.source);
                changed = this.terminals.delete(session.source) || changed;
            }
        }
        const details = record(message.details);
        if (details && typeof details.requestId === "string" && (message.customType === "ask:background-answer" || ["completed", "failed", "cancelled"].includes(details.status))) {
            this.completedRequests.add(details.requestId);
            changed = this.requests.delete(details.requestId) || changed;
        }
        return changed;
    }
    /** Track only reported native descendants. A remote PID is never local ownership. */
    async trackProcesses(value) {
        const data = record(value);
        if (!data || data.remote || data.origin?.sessionId && data.origin.sessionId !== this.sessionId || !Number.isInteger(data.pid) || data.pid <= 0 || data.pid === process.pid)
            return;
        const identity = await processIdentity(data.pid);
        if (!identity || !await descendsFrom(data.pid, process.pid))
            return;
        if (typeof data.source === "string" && data.source.startsWith("shell:"))
            identity.terminal = data.source;
        this.processes.set(identity.pid, identity);
        await this.captureChildren(identity);
    }
    async captureChildren(identity) {
        const current = await processIdentity(identity.pid);
        if (!sameProcess(identity, current))
            return;
        let children;
        try {
            children = await readFile(`/proc/${identity.pid}/task/${identity.pid}/children`, "utf8");
        }
        catch {
            return;
        }
        for (const pid of children.trim().split(/\s+/).map(Number).filter(pid => pid > 0)) {
            if (this.processes.has(pid))
                continue;
            const child = await processIdentity(pid);
            if (child) {
                child.terminal = identity.terminal;
                this.processes.set(pid, child);
                await this.captureChildren(child);
            }
        }
    }
    /** Keep unknown ownership pending; a vanished or replaced incarnation is finished. */
    async refreshProcesses() {
        const completed = [];
        if (!this.processes.size)
            return completed;
        let boot;
        try {
            boot = (await readFile("/proc/sys/kernel/random/boot_id", "utf8")).trim();
        }
        catch {
            return completed;
        }
        for (const identity of this.processes.values()) {
            // A different machine/boot cannot tell us whether the original job ended.
            if (identity.boot !== boot)
                continue;
            await this.captureChildren(identity);
            const current = await processIdentity(identity.pid);
            if (current === undefined)
                continue;
            if (sameProcess(identity, current)) {
                // Terminal completion already reports its shell and commands. Wake again only
                // for a descendant observed still alive after that completion was delivered.
                if (identity.terminal && !this.terminals.has(identity.terminal))
                    identity.notify = true;
            }
            else {
                this.processes.delete(identity.pid);
                if (!identity.terminal || identity.notify)
                    completed.push(identity.pid);
            }
        }
        return completed;
    }
}
function sameProcess(a, b) { return !!b && a.start === b.start && a.boot === b.boot; }
async function processFields(pid) {
    try {
        const stat = await readFile(`/proc/${pid}/stat`, "utf8");
        return stat.slice(stat.lastIndexOf(")") + 2).trim().split(/\s+/);
    }
    catch (error) {
        return error.code === "ENOENT" ? null : undefined;
    }
}
async function processIdentity(pid) {
    if (process.platform !== "linux")
        return undefined;
    const fields = await processFields(pid);
    if (!fields)
        return fields;
    if (["Z", "X"].includes(fields[0]))
        return null;
    try {
        return { pid, start: fields[19], boot: (await readFile("/proc/sys/kernel/random/boot_id", "utf8")).trim() };
    }
    catch {
        return undefined;
    }
}
async function descendsFrom(pid, owner) {
    const seen = new Set();
    while (pid > 1 && !seen.has(pid)) {
        seen.add(pid);
        const fields = await processFields(pid);
        if (!fields)
            return false;
        pid = Number(fields[1]);
        if (pid === owner)
            return true;
    }
    return false;
}
/** Tool wrappers may expose data in details, structuredContent, or a JSON receipt. */
export function workFacts(result) {
    const value = record(result);
    if (!value)
        return [];
    const facts = [value.details, value.structuredContent];
    for (const part of value.content ?? []) {
        if (part?.type !== "text" || typeof part.text !== "string" || !part.text.trimStart().startsWith("{"))
            continue;
        try {
            facts.push(JSON.parse(part.text));
        }
        catch { /* Ordinary text is not a receipt. */ }
    }
    return facts.filter(Boolean).flatMap(fact => {
        const results = record(fact)?.results;
        return Array.isArray(results) ? [fact, ...results] : [fact];
    });
}
