import { afterEach, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appendLineageInbox, discoverLineageRoots, pendingLineageInboxes, registerLineage } from "../pi-extension/subagents/lineage.ts";
import { childSessionLocation, parentSessionLocation, publishSessionLocation, readSessionBinding, registerSessionLineage, seedSessionBinding, sessionLocationAlive, beginChildSessionMove, sessionServerAlive, writeBindingFile } from "../pi-extension/subagents/session-binding.ts";
import { waitForCompletion } from "../pi-extension/subagents/completion.ts";
import { sessionOwnsPane } from "../pi-extension/subagents/session-binding.ts";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function fixture() {
	const root = mkdtempSync(join(tmpdir(), "session-binding-"));
	roots.push(root);
	const storeDir = join(root, "store");
	const source = join(root, "source.jsonl");
	const destinationDir = join(root, "destination");
	mkdirSync(destinationDir);
	const moved = join(destinationDir, "moved.jsonl");
	const lineage = registerLineage({ artifactDir: root, nodeId: "worker", parentSessionId: "parent", parentSessionFile: source });
	writeFileSync(source, JSON.stringify({ type: "session", version: 3, id: "parent", cwd: root }) + "\n");
	return { root, storeDir, source, moved, destinationDir, lineage };
}

test("discovers all owned roots after the session moves outside its original directory", () => {
	const f = fixture();
	seedSessionBinding(f.source, { version: 1, storeDir: f.storeDir });
	const second = registerLineage({ artifactDir: f.root, nodeId: "second", parentSessionId: "parent" });
	registerSessionLineage(f.storeDir, "parent", f.lineage.rootDir);
	registerSessionLineage(f.storeDir, "parent", second.rootDir);
	writeFileSync(f.moved, readFileSync(f.source));
	rmSync(f.source);
	assert.deepEqual(discoverLineageRoots(f.destinationDir, f.moved).sort(), [f.lineage.rootDir, second.rootDir].sort());
});

test("a fork carrying copied binding entries cannot take the original ownership", () => {
	const f = fixture();
	seedSessionBinding(f.source, { version: 1, storeDir: f.storeDir });
	registerSessionLineage(f.storeDir, "parent", f.lineage.rootDir);
	const rows = readFileSync(f.source, "utf8").trim().split("\n").map((line) => JSON.parse(line));
	rows[0].id = "independent-copy";
	writeFileSync(f.moved, rows.map((row) => JSON.stringify(row)).join("\n") + "\n");
	assert.equal(readSessionBinding(f.moved), undefined);
	assert.deepEqual(discoverLineageRoots(f.destinationDir, f.moved), []);
});

test("pending delivery follows the parent key, not the old file path", () => {
	const f = fixture();
	appendLineageInbox(f.lineage.rootDir, "worker", "terminal:worker", { sessionId: "parent", sessionFile: f.source }, { resultContent: "answer" });
	const pending = pendingLineageInboxes(f.lineage.rootDir, "parent", f.moved);
	assert.equal(pending.length, 1);
	assert.equal(pending[0].sessionFile, f.moved);
	assert.deepEqual(pendingLineageInboxes(f.lineage.rootDir, "other-parent", f.moved), []);
});

test("child identity and location survive a copied session without its sidecar", () => {
	const f = fixture();
	const binding = seedSessionBinding(f.source, { version: 1, storeDir: f.storeDir, child: { lineage: f.lineage, environment: { PI_SUBAGENT_ID: "worker" } } });
	writeFileSync(f.moved, readFileSync(f.source));
	rmSync(f.source);
	publishSessionLocation(binding, { sessionFile: f.moved, cwd: f.destinationDir, paneId: "new-pane" });
	assert.equal(childSessionLocation(f.lineage.rootDir, "worker")?.sessionFile, f.moved);
	assert.equal(childSessionLocation(f.lineage.rootDir, "worker")?.paneId, "new-pane");
	assert.equal(parentSessionLocation(f.storeDir, "parent")?.sessionFile, f.moved);
	assert.equal(sessionLocationAlive(childSessionLocation(f.lineage.rootDir, "worker")!), true);
	assert.equal(sessionLocationAlive({ ...childSessionLocation(f.lineage.rootDir, "worker")!, processStart: "different-incarnation" }), false);
});

test("a child move keeps its durable handoff evidence after source deletion and clears it on destination startup", () => {
	const f = fixture();
	const binding = seedSessionBinding(f.source, { version: 1, storeDir: f.storeDir, child: { lineage: f.lineage, environment: {} } });
	const source = publishSessionLocation(binding, { sessionFile: f.source, cwd: f.root, serverPid: process.pid });
	assert.equal(sessionServerAlive({ ...source, serverStart: source.processStart }), true);
	assert.equal(sessionServerAlive({ ...source, serverStart: "old-server" }), false);
	beginChildSessionMove(binding);
	writeFileSync(f.moved, readFileSync(f.source));
	rmSync(f.source);
	assert.ok(childSessionLocation(f.lineage.rootDir, "worker")!.moveDeadline! > Date.now());
	publishSessionLocation(binding, { sessionFile: f.moved, cwd: f.destinationDir });
	assert.equal(childSessionLocation(f.lineage.rootDir, "worker")?.moveDeadline, undefined);
});
test("a reused pane ID cannot authorize cleanup of a different shell incarnation", () => {
	const f = fixture();
	const binding = seedSessionBinding(f.source, { version: 1, storeDir: f.storeDir });
	const location = publishSessionLocation(binding, { sessionFile: f.source, cwd: f.root, paneId: "same-pane", shellPid: process.pid });
	const proven = { ...location, shellStart: location.processStart };
	assert.equal(sessionOwnsPane(proven, "same-pane", process.pid), true);
	assert.equal(sessionOwnsPane({ ...proven, shellStart: "reused" }, "same-pane", process.pid), false);
	assert.equal(sessionOwnsPane(proven, "other-pane", process.pid), false);
});
test("completion reads the moved child's durable answer rather than its old pane", async () => {
	const f = fixture();
	writeBindingFile(`${f.moved}.exit`, { type: "done", summary: "saved answer" });
	const result = await waitForCompletion(new AbortController().signal, {
		intervalMs: 1, sessionFile: f.source, resolveSessionFile: () => f.moved,
		readTerminalTail: async () => { throw new Error("old pane disappeared"); },
	});
	assert.equal(result.summary, "saved answer");
	assert.equal(result.reason, "done");
});
