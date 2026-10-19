import assert from "node:assert/strict";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";
import { readSessionBinding, seedSessionBinding } from "../pi-extension/subagents/session-binding.ts";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });
function fixture() {
	const root = fs.mkdtempSync(join(tmpdir(), "binding-reads-")); roots.push(root);
	const file = join(root, "session.jsonl");
	fs.writeFileSync(file, JSON.stringify({ type: "session", id: "parent" }) + "\n");
	const binding = seedSessionBinding(file, { version: 1, storeDir: root });
	return { root, file, binding };
}

test("repeated binding checks do not reread conversation history, including appended output", () => {
	const f = fixture();
	fs.appendFileSync(f.file, JSON.stringify({ type: "message", message: { content: "x".repeat(2 * 1024 * 1024) } }) + "\n");
	assert.deepEqual(readSessionBinding(f.file), f.binding);
	const readFile = fs.readFileSync, read = fs.readSync;
	let bytes = 0;
	fs.readFileSync = ((...args: Parameters<typeof fs.readFileSync>) => {
		const result = readFile(...args);
		bytes += typeof result === "string" ? Buffer.byteLength(result) : result.length;
		return result;
	}) as typeof fs.readFileSync;
	fs.readSync = ((...args: Parameters<typeof fs.readSync>) => { const count = read(...args); bytes += count; return count; }) as typeof fs.readSync;
	syncBuiltinESMExports();
	try {
		for (let index = 0; index < 10; index++) {
			fs.appendFileSync(f.file, JSON.stringify({ type: "message", text: `new output ${index}` }) + "\n");
			assert.deepEqual(readSessionBinding(f.file), f.binding);
		}
		console.log(JSON.stringify({ incrementalBindingReadBytes: bytes }));
		assert.ok(bytes < 128 * 1024, `ten incremental checks read ${bytes} bytes`);
	} finally { fs.readFileSync = readFile; fs.readSync = read; syncBuiltinESMExports(); }
});

test("binding reads follow appended records and ignore an incomplete UTF-8 tail until it is complete", () => {
	const f = fixture();
	assert.deepEqual(readSessionBinding(f.file), f.binding);
	const updated = { ...f.binding, storeDir: join(f.root, "новый") };
	const row = Buffer.from(JSON.stringify({ type: "custom", customType: "subagent-session-binding", data: updated }) + "\n");
	const split = row.indexOf(Buffer.from("новый")) + 1;
	fs.appendFileSync(f.file, row.subarray(0, split));
	assert.deepEqual(readSessionBinding(f.file), f.binding);
	fs.appendFileSync(f.file, row.subarray(split));
	assert.deepEqual(readSessionBinding(f.file), updated);
	const result = readSessionBinding(f.file)!; result.storeDir = "/not-the-stored-binding";
	assert.deepEqual(readSessionBinding(f.file), updated);
});

test("a growing rewrite cannot keep an old binding merely because its tail is unchanged", () => {
	const f = fixture();
	fs.appendFileSync(f.file, JSON.stringify({ type: "message", text: "x".repeat(512) }) + "\n");
	const source = fs.readFileSync(f.file, "utf8");
	assert.deepEqual(readSessionBinding(f.file), f.binding);
	const updated = { ...f.binding, storeDir: f.root.replace("binding-reads", "binding-tests") };
	fs.writeFileSync(f.file, source.replace(f.binding.storeDir, updated.storeDir) + JSON.stringify({ type: "message", text: "new output" }) + "\n");
	assert.deepEqual(readSessionBinding(f.file), updated);
});
test("a concurrent replacement cannot mix one file's header with another file's binding", () => {
	const f = fixture();
	const replacement = join(f.root, "replacement");
	const foreign = { ...f.binding, storeDir: join(f.root, "foreign") };
	fs.writeFileSync(replacement, JSON.stringify({ type: "session", id: "forked" }) + "\n" + JSON.stringify({ type: "custom", customType: "subagent-session-binding", data: foreign }) + "\n");
	const read = fs.readSync;
	let replaced = false;
	fs.readSync = ((...args: Parameters<typeof fs.readSync>) => {
		if (!replaced) { replaced = true; fs.renameSync(replacement, f.file); }
		return read(...args);
	}) as typeof fs.readSync;
	syncBuiltinESMExports();
	try { assert.deepEqual(readSessionBinding(f.file), f.binding); }
	finally { fs.readSync = read; syncBuiltinESMExports(); }
	assert.equal(readSessionBinding(f.file), undefined);
});
test("replacement, truncation and same-length header rewrites invalidate cached ownership", () => {
	const f = fixture();
	const source = fs.readFileSync(f.file, "utf8");
	assert.deepEqual(readSessionBinding(f.file), f.binding);
	fs.writeFileSync(f.file, source.replace('"id":"parent"', '"id":"forked"'));
	assert.equal(readSessionBinding(f.file), undefined);
	fs.writeFileSync(f.file, JSON.stringify({ type: "session", id: "parent" }) + "\n");
	assert.equal(readSessionBinding(f.file), undefined);
	const replacement = join(f.root, "replacement"); fs.writeFileSync(replacement, source); fs.renameSync(replacement, f.file);
	assert.deepEqual(readSessionBinding(f.file), f.binding);
	fs.unlinkSync(f.file);
	assert.equal(readSessionBinding(f.file), undefined);
	fs.writeFileSync(f.file, source);
	assert.deepEqual(readSessionBinding(f.file), f.binding);
});
