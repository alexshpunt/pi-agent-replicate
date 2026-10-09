import { appendFileSync, closeSync, fsyncSync, existsSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { dirname, isAbsolute, join } from "node:path";
import { homedir } from "node:os";
import type { LineageRegistration } from "./lineage.ts";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { getPaneProcessInfo } from "./terminal.ts";

export const SESSION_BINDING_TYPE = "subagent-session-binding";

/** Bind the freshly opened context and restore only session-owned child settings. */
export function bindSessionRuntime(pi: ExtensionAPI, ctx: ExtensionContext): SessionBinding | undefined {
	const manager = ctx.sessionManager;
	const sessionFile = manager?.getSessionFile?.();
	const sessionId = manager?.getSessionId?.();
	if (!sessionFile || !sessionId) return undefined;
	let binding = readSessionBinding(sessionFile);
	if (!binding) {
		binding = { version: 1, sessionId, storeDir: sessionBindingStore() };
		pi.appendEntry(SESSION_BINDING_TYPE, binding);
	}
	if (binding.child) {
		for (const [key, value] of Object.entries(binding.child.environment)) {
			if ((key.startsWith("PI_SUBAGENT_") || key === "PI_DENY_TOOLS") && typeof value === "string") process.env[key] = value;
		}
		process.env.PI_SUBAGENT_SESSION = sessionFile;
		process.env.PI_SUBAGENT_LAUNCHER_PID = String(process.ppid);
		process.env.PI_SUBAGENT_SURFACE = process.env.HERDR_PANE_ID;
	}
	let shellPid: number | undefined;
	try { if (process.env.HERDR_PANE_ID) shellPid = getPaneProcessInfo(process.env.HERDR_PANE_ID).shellPid; } catch { /* No verified pane means no destructive cleanup. */ }
	publishSessionLocation(binding, {
		shellPid, shellStart: shellPid ? startTime(shellPid) : undefined,
		serverPid: shellPid ? parentPid(shellPid) : undefined,
		serverStart: shellPid && parentPid(shellPid) ? startTime(parentPid(shellPid)!) : undefined,
		sessionFile, cwd: ctx.cwd,
		paneId: process.env.HERDR_PANE_ID,
		tabId: process.env.HERDR_TAB_ID,
		workspaceId: process.env.HERDR_WORKSPACE_ID,
	});
	return binding;
}

/** Session-owned identity. Copies with another header ID cannot inherit ownership. */
export interface SessionBinding {
	version: 1;
	sessionId: string;
	storeDir: string;
	child?: {
		lineage: LineageRegistration;
		environment: Record<string, string>;
	};
}

/** Latest verified session incarnation; Herdr pane IDs alone are not durable identity. */
export interface SessionLocation {
	version: 1;
	sessionId: string;
	sessionFile: string;
	pid: number;
	processStart?: string;
	shellPid?: number;
	shellStart?: string;
	serverPid?: number;
	serverStart?: string;
	childNodeId?: string;
	childRootDir?: string;
	moveDeadline?: number;
	paneId?: string;
	tabId?: string;
	workspaceId?: string;
	cwd: string;
}

/** Atomically save state and sync both its bytes and directory before returning. */
export function writeBindingFile(path: string, value: unknown): void {
	mkdirSync(dirname(path), { recursive: true });
	const temporary = `${path}.${randomUUID()}.tmp`;
	let fd: number | undefined;
	try {
		fd = openSync(temporary, "wx", 0o600);
		writeFileSync(fd, JSON.stringify(value));
		fsyncSync(fd);
		closeSync(fd);
		fd = undefined;
		renameSync(temporary, path);
		const directory = openSync(dirname(path), "r");
		try { fsyncSync(directory); } finally { closeSync(directory); }
	} finally {
		if (fd !== undefined) closeSync(fd);
		try { unlinkSync(temporary); } catch { /* Already published or not created. */ }
	}
}

function readJson(path: string): any {
	try { return JSON.parse(readFileSync(path, "utf8")); } catch { return undefined; }
}

/** Read a binding only when its key matches the containing session header. */
export function readSessionBinding(sessionFile: string): SessionBinding | undefined {
	let rows: any[];
	try {
		rows = readFileSync(sessionFile, "utf8").split("\n").filter(Boolean).flatMap((line) => {
			try { return [JSON.parse(line)]; } catch { return []; }
		});
	} catch { return undefined; }
	const header = rows[0];
	if (header?.type !== "session" || typeof header.id !== "string") return undefined;
	for (const row of rows.reverse()) {
		const binding = row.data;
		if (row.type !== "custom" || row.customType !== SESSION_BINDING_TYPE) continue;
		if (binding?.version !== 1 || binding.sessionId !== header.id || typeof binding.storeDir !== "string" || !isAbsolute(binding.storeDir)) continue;
		if (binding.child && (!binding.child.lineage?.rootDir || !binding.child.lineage?.nodeId || !binding.child.environment)) continue;
		return binding;
	}
	return undefined;
}

/** Use the store carried by the session, even when it moved to another agent directory. */
export function sessionBindingStore(sessionFile?: string, agentDir?: string): string {
	return (sessionFile ? readSessionBinding(sessionFile)?.storeDir : undefined)
		?? join(agentDir ?? process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent"), "subagent-sessions");
}

function ownerDir(storeDir: string, sessionId: string): string {
	return join(storeDir, "owners", encodeURIComponent(sessionId));
}

/** Index each lineage independently so simultaneous launches cannot overwrite siblings. */
export function registerSessionLineage(storeDir: string, sessionId: string, rootDir: string): void {
	writeBindingFile(join(ownerDir(storeDir, sessionId), `${createHash("sha256").update(rootDir).digest("hex")}.json`), { version: 1, sessionId, rootDir });
}

/** Find ownership by the durable session key, not the current cwd or file path. */
export function sessionLineageRoots(storeDir: string, sessionId: string): string[] {
	const directory = ownerDir(storeDir, sessionId);
	let names: string[];
	try { names = readdirSync(directory); } catch { return []; }
	return names.filter((name) => name.endsWith(".json")).flatMap((name) => {
		const record = readJson(join(directory, name));
		return record?.version === 1 && record.sessionId === sessionId && typeof record.rootDir === "string" && isAbsolute(record.rootDir) ? [record.rootDir] : [];
	});
}

/** Seed child identity before starting Pi. A running session must use pi.appendEntry instead. */
export function seedSessionBinding(sessionFile: string, binding: Omit<SessionBinding, "sessionId">): SessionBinding {
	const raw = readFileSync(sessionFile, "utf8");
	const rows = raw.trim().split("\n").map((line) => JSON.parse(line));
	const header = rows[0];
	if (header.type !== "session" || typeof header.id !== "string") throw new Error("Cannot bind a child without a session header");
	const data: SessionBinding = { ...binding, sessionId: header.id };
	appendFileSync(sessionFile, JSON.stringify({ type: "custom", id: randomUUID(), parentId: rows.at(-1)?.id ?? null, timestamp: new Date().toISOString(), customType: SESSION_BINDING_TYPE, data }) + "\n");
	const fd = openSync(sessionFile, "r");
	try { fsyncSync(fd); } finally { closeSync(fd); }
	return data;
}

function parentPid(pid: number): number | undefined {
	try {
		const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
		return Number(stat.slice(stat.lastIndexOf(")") + 2).split(/\s+/)[1]) || undefined;
	} catch { return undefined; }
}
function startTime(pid: number): string | undefined {
	try {
		const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
		return stat.slice(stat.lastIndexOf(")") + 2).split(/\s+/)[19];
	} catch { return undefined; }
}

/** Publish one startup's exact file and pane, surviving both Teleport and Herdr restarts. */
export function publishSessionLocation(binding: SessionBinding, input: Omit<SessionLocation, "version" | "sessionId" | "pid" | "processStart">): SessionLocation {
	const location: SessionLocation = {
		version: 1, sessionId: binding.sessionId, ...input, pid: process.pid, processStart: startTime(process.pid),
		...(binding.child ? { childNodeId: binding.child.lineage.nodeId, childRootDir: binding.child.lineage.rootDir } : {}),
	};
	writeBindingFile(join(binding.storeDir, "locations", `${encodeURIComponent(binding.sessionId)}.json`), location);
	if (binding.child) writeBindingFile(join(binding.child.lineage.rootDir, "locations", `${encodeURIComponent(binding.child.lineage.nodeId)}.json`), location);
	return location;
}

/** Hold child completion while Teleport starts a replacement, with a bounded failure gate. */
export function beginChildSessionMove(binding: SessionBinding): void {
	if (!binding.child) return;
	const path = join(binding.child.lineage.rootDir, "locations", `${encodeURIComponent(binding.child.lineage.nodeId)}.json`);
	const location = readJson(path);
	if (validLocation(location) && location.pid === process.pid) writeBindingFile(path, { ...location, moveDeadline: Date.now() + 15_000 });
}
/** A dead process still supplies a recoverable saved location, never a live receiver. */
export function sessionLocationAlive(location: SessionLocation): boolean {
	try { process.kill(location.pid, 0); } catch { return false; }
	return location.processStart !== undefined && startTime(location.pid) === location.processStart;
}

/** A lost pane is not a user cancellation when its Herdr incarnation also died. */
export function sessionServerAlive(location: SessionLocation): boolean | undefined {
	if (!location.serverPid || !location.serverStart) return undefined;
	return startTime(location.serverPid) === location.serverStart;
}
/** Allow pane cleanup only while its original shell incarnation still owns it. */
export function sessionOwnsPane(location: SessionLocation, paneId: string, shellPid: number | undefined): boolean {
	return location.paneId === paneId && location.shellPid === shellPid && shellPid !== undefined
		&& location.shellStart !== undefined && startTime(shellPid) === location.shellStart;
}
function validLocation(value: any): value is SessionLocation {
	return value?.version === 1 && typeof value.sessionId === "string" && typeof value.sessionFile === "string" && isAbsolute(value.sessionFile) && Number.isInteger(value.pid) && value.pid > 0 && typeof value.cwd === "string";
}

/** Resolve the last registered incarnation of a child. */
export function childSessionLocation(rootDir: string, nodeId: string): SessionLocation | undefined {
	const value = readJson(join(rootDir, "locations", `${encodeURIComponent(nodeId)}.json`));
	if (!validLocation(value)) return undefined;
	const binding = readSessionBinding(value.sessionFile);
	if (binding?.child?.lineage.rootDir === rootDir && binding.child.lineage.nodeId === nodeId) return value;
	// Teleport may remove the source before the replacement finishes extension startup.
	if (value.childRootDir === rootDir && value.childNodeId === nodeId && !existsSync(value.sessionFile)) return value;
	return undefined;
}

/** Resolve a parent with matching session evidence; a copied branch is not a receiver. */
export function parentSessionLocation(storeDir: string, sessionId: string): SessionLocation | undefined {
	const value = readJson(join(storeDir, "locations", `${encodeURIComponent(sessionId)}.json`));
	if (!validLocation(value) || value.sessionId !== sessionId) return undefined;
	try {
		const header = JSON.parse(readFileSync(value.sessionFile, "utf8").split("\n")[0]);
		return header.type === "session" && header.id === sessionId ? value : undefined;
	} catch { return undefined; }
}
