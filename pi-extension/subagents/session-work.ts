import { readFile } from "node:fs/promises";

interface OwnedProcess { pid: number; start: string; boot: string; terminal?: string; notify?: boolean }
export interface SessionWorkSnapshot {
  sessionId: string;
  terminals: string[];
  requests: string[];
  processes: OwnedProcess[];
}
const record = (value: unknown): Record<string, any> | undefined => value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, any> : undefined;

/** Work receipts belong to this session, not inherited conversation or the terminal host. */
export class SessionWork {
  private readonly tools = new Set<string>();
  private readonly terminals = new Set<string>();
  private readonly requests = new Set<string>();
  private readonly completedTerminals = new Set<string>();
  private readonly completedRequests = new Set<string>();
  private readonly processes = new Map<number, OwnedProcess>();
  private readonly sessionId: string;
  constructor(sessionId: string, saved?: SessionWorkSnapshot) {
    this.sessionId = sessionId;
    if (saved?.sessionId !== sessionId) return;
    for (const source of saved.terminals ?? []) if (typeof source === "string") this.terminals.add(source);
    for (const id of saved.requests ?? []) if (typeof id === "string") this.requests.add(id);
    for (const identity of saved.processes ?? []) if (Number.isInteger(identity.pid) && identity.pid > 0 && typeof identity.start === "string" && typeof identity.boot === "string") this.processes.set(identity.pid, identity);
  }
  get pending(): boolean { return this.tools.size + this.terminals.size + this.requests.size + this.processes.size > 0; }
  snapshot(): SessionWorkSnapshot { return { sessionId: this.sessionId, terminals: [...this.terminals], requests: [...this.requests], processes: [...this.processes.values()] }; }
  toolStarted(id: string): void { this.tools.add(id); }
  toolEnded(id: string): void { this.tools.delete(id); }
  toolResult(value: unknown, inspection = false): void {
    const data = record(value);
    if (inspection && data?.origin?.sessionId !== this.sessionId) return;
    if (!data || data.origin?.sessionId && data.origin.sessionId !== this.sessionId) return;
    if (typeof data.source === "string" && data.source.startsWith("shell:") && !this.completedTerminals.has(data.source) && ["running", "stopping"].includes(data.status)) this.terminals.add(data.source);
    if (typeof data.requestId === "string") {
      if (["completed", "failed", "cancelled"].includes(data.status) || data.answers !== undefined) {
        this.completedRequests.add(data.requestId);
        this.requests.delete(data.requestId);
      } else if (!this.completedRequests.has(data.requestId) && ["running", "queued"].includes(data.status)) this.requests.add(data.requestId);
    }
  }
  /** Completion arrival invalidates an old final answer; Pi processes the message normally. */
  message(value: unknown): boolean {
    const message = record(value);
    if (!message) return false;
    let changed = false;
    if (message.customType === "terminal-completion") {
      for (const session of message.details?.sessions ?? []) {
        if (session.origin?.sessionId && session.origin.sessionId !== this.sessionId) continue;
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
  async trackProcesses(value: unknown): Promise<void> {
    const data = record(value);
    if (!data || data.remote || data.origin?.sessionId && data.origin.sessionId !== this.sessionId || !Number.isInteger(data.pid) || data.pid <= 0 || data.pid === process.pid) return;
    const identity = await processIdentity(data.pid);
    if (!identity || !await descendsFrom(data.pid, process.pid)) return;
    if (typeof data.source === "string" && data.source.startsWith("shell:")) identity.terminal = data.source;
    this.processes.set(identity.pid, identity);
    await this.captureChildren(identity);
  }
  private async captureChildren(identity: OwnedProcess): Promise<void> {
    const current = await processIdentity(identity.pid);
    if (!sameProcess(identity, current)) return;
    let children: string;
    try { children = await readFile(`/proc/${identity.pid}/task/${identity.pid}/children`, "utf8"); } catch { return; }
    for (const pid of children.trim().split(/\s+/).map(Number).filter(pid => pid > 0)) {
      if (this.processes.has(pid)) continue;
      const child = await processIdentity(pid);
      if (child) { child.terminal = identity.terminal; this.processes.set(pid, child); await this.captureChildren(child); }
    }
  }
  /** Keep unknown ownership pending; a vanished or replaced incarnation is finished. */
  async refreshProcesses(): Promise<number[]> {
    const completed: number[] = [];
    if (!this.processes.size) return completed;
    let boot: string;
    try { boot = (await readFile("/proc/sys/kernel/random/boot_id", "utf8")).trim(); } catch { return completed; }
    for (const identity of this.processes.values()) {
      // A different machine/boot cannot tell us whether the original job ended.
      if (identity.boot !== boot) continue;
      await this.captureChildren(identity);
      const current = await processIdentity(identity.pid);
      if (current === undefined) continue;
      if (sameProcess(identity, current)) {
        // Terminal completion already reports its shell and commands. Wake again only
        // for a descendant observed still alive after that completion was delivered.
        if (identity.terminal && !this.terminals.has(identity.terminal)) identity.notify = true;
      } else {
        this.processes.delete(identity.pid);
        if (!identity.terminal || identity.notify) completed.push(identity.pid);
      }
    }
    return completed;
  }
}
function sameProcess(a: OwnedProcess, b: OwnedProcess | null | undefined): boolean { return !!b && a.start === b.start && a.boot === b.boot; }
async function processFields(pid: number): Promise<string[] | null | undefined> {
  try { const stat = await readFile(`/proc/${pid}/stat`, "utf8"); return stat.slice(stat.lastIndexOf(")") + 2).trim().split(/\s+/); }
  catch (error) { return (error as NodeJS.ErrnoException).code === "ENOENT" ? null : undefined; }
}
async function processIdentity(pid: number): Promise<OwnedProcess | null | undefined> {
  if (process.platform !== "linux") return undefined;
  const fields = await processFields(pid);
  if (!fields) return fields;
  if (["Z", "X"].includes(fields[0])) return null;
  try { return { pid, start: fields[19], boot: (await readFile("/proc/sys/kernel/random/boot_id", "utf8")).trim() }; } catch { return undefined; }
}
async function descendsFrom(pid: number, owner: number): Promise<boolean> {
  const seen = new Set<number>();
  while (pid > 1 && !seen.has(pid)) {
    seen.add(pid);
    const fields = await processFields(pid);
    if (!fields) return false;
    pid = Number(fields[1]);
    if (pid === owner) return true;
  }
  return false;
}

/** Tool wrappers may expose data in details, structuredContent, or a JSON receipt. */
export function workFacts(result: unknown): unknown[] {
  const value = record(result);
  if (!value) return [];
  const facts: unknown[] = [value.details, value.structuredContent];
  for (const part of value.content ?? []) {
    if (part?.type !== "text" || typeof part.text !== "string" || !part.text.trimStart().startsWith("{")) continue;
    try { facts.push(JSON.parse(part.text)); } catch { /* Ordinary text is not a receipt. */ }
  }
  return facts.filter(Boolean).flatMap(fact => {
    const results = record(fact)?.results;
    return Array.isArray(results) ? [fact, ...results] : [fact];
  });
}
