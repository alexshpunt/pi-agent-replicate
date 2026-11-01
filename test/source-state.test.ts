import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it } from "node:test";
import { snapshotSource, planSourceJoin, applySourceJoin, sourceRepositoryAnchor } from "../pi-extension/subagents/source-state.ts";

import { writeBindingFile } from "../pi-extension/subagents/session-binding.ts";
function fixture() {
	const dir = mkdtempSync(join(tmpdir(), "replica-source-"));
	const repo = join(dir, "repo"), store = join(dir, "store");
	mkdirSync(repo); mkdirSync(store);
	const git = (...args: string[]) => execFileSync("git", args, { cwd: repo, encoding: "utf8" }).trim();
	git("init", "-q"); git("config", "user.name", "Test"); git("config", "user.email", "test@example.invalid");
	writeFileSync(join(repo, "one.txt"), "base one\n"); writeFileSync(join(repo, "two.txt"), "base two\n");
	writeFileSync(join(repo, ".gitignore"), "ignored\n"); git("add", "."); git("commit", "-qm", "base");
	const index = () => readFileSync(join(repo, git("rev-parse", "--git-path", "index")));
	return { dir, repo, store, git, index };
}

it("finds the main Herdr allocation anchor while snapshotting a linked child's own files", () => {
	const f = fixture(), child = join(f.dir, "child");
	try {
		f.git("worktree", "add", "-qb", "child", child);
		writeFileSync(join(child, "one.txt"), "child working state\n");
		const saved = snapshotSource(child, f.store);
		assert.equal(sourceRepositoryAnchor(child), f.repo);
		assert.equal(f.git("show", saved.commit + ":one.txt"), "child working state");
		assert.equal(readFileSync(join(f.repo, "one.txt"), "utf8"), "base one\n");
	} finally { f.git("worktree", "remove", "--force", child); rmSync(f.dir, { recursive: true, force: true }); }
});
it("rejects skip-worktree and assume-unchanged files instead of taking an incomplete snapshot", () => {
	const f = fixture();
	try {
		f.git("update-index", "--skip-worktree", "one.txt");
		assert.throws(() => snapshotSource(f.repo, f.store), /sparse/);
		f.git("update-index", "--no-skip-worktree", "one.txt");
		f.git("update-index", "--assume-unchanged", "two.txt");
		assert.throws(() => snapshotSource(f.repo, f.store), /assume-unchanged/);
	} finally { rmSync(f.dir, { recursive: true, force: true }); }
});
it("captures dirty source and untracked files without changing the real HEAD or index", () => {
	const f = fixture();
	try {
		writeFileSync(join(f.repo, "one.txt"), "staged\n"); f.git("add", "one.txt");
		writeFileSync(join(f.repo, "one.txt"), "working\n"); rmSync(join(f.repo, "two.txt"));
		writeFileSync(join(f.repo, "new source.txt"), Buffer.from([0, 1, 2, 255]));
		writeFileSync(join(f.repo, "ignored"), "not a snapshot\n"); symlinkSync("one.txt", join(f.repo, "link"));
		const head = f.git("rev-parse", "HEAD"), index = f.index();
		const saved = snapshotSource(f.repo, f.store);
		assert.equal(f.git("rev-parse", "HEAD"), head); assert.deepEqual(f.index(), index);
		assert.equal(f.git("show", `${saved.commit}:one.txt`), "working");
		assert.equal(f.git("show", `${saved.commit}:link`), "one.txt");
		const files = f.git("ls-tree", "-r", "--name-only", saved.commit);
		assert.match(files, /new source.txt/); assert.doesNotMatch(files, /two.txt|ignored/);
		assert.deepEqual(execFileSync("git", ["show", `${saved.commit}:new source.txt`], { cwd: f.repo }), Buffer.from([0, 1, 2, 255]));
	} finally { rmSync(f.dir, { recursive: true, force: true }); }
});

it("captures newly staged working files even when their path is ignored", () => {
	const f = fixture();
	try {
		writeFileSync(join(f.repo, "ignored"), "staged content\n");
		f.git("add", "-f", "ignored");
		writeFileSync(join(f.repo, "ignored"), "working content\n");
		const head = f.git("rev-parse", "HEAD"), index = f.index();
		const saved = snapshotSource(f.repo, f.store);
		assert.equal(f.git("show", `${saved.commit}:ignored`), "working content");
		assert.equal(f.git("rev-parse", "HEAD"), head);
		assert.deepEqual(f.index(), index);
	} finally { rmSync(f.dir, { recursive: true, force: true }); }
});

it("joins child changes into a dirty parent without replacing its staging or applying them twice", () => {
	const f = fixture();
	try {
		writeFileSync(join(f.repo, "one.txt"), "parent staged\n"); f.git("add", "one.txt");
		const base = snapshotSource(f.repo, f.store);
		writeFileSync(join(f.repo, "two.txt"), "child two\n");
		writeFileSync(join(f.repo, "child.txt"), "child file\n");
		const child = snapshotSource(f.repo, f.store);
		writeFileSync(join(f.repo, "two.txt"), "base two\n"); rmSync(join(f.repo, "child.txt"));
		writeFileSync(join(f.repo, "one.txt"), "parent later\n");
		const index = f.index(), head = f.git("rev-parse", "HEAD");
		const plan = planSourceJoin(f.repo, base.commit, child.commit, f.store);
		assert.equal(plan.status, "ready");
		if (plan.status !== "ready") assert.fail("join should be ready");
		applySourceJoin(plan);
		assert.equal(readFileSync(join(f.repo, "one.txt"), "utf8"), "parent later\n");
		assert.equal(readFileSync(join(f.repo, "two.txt"), "utf8"), "child two\n");
		assert.equal(readFileSync(join(f.repo, "child.txt"), "utf8"), "child file\n");
		assert.deepEqual(f.index(), index); assert.equal(f.git("rev-parse", "HEAD"), head);
		applySourceJoin(plan);
		assert.equal(readFileSync(join(f.repo, "two.txt"), "utf8"), "child two\n");
		assert.ok(existsSync(plan.journalFile));
	} finally { rmSync(f.dir, { recursive: true, force: true }); }
});

it("keeps a prepared join recoverable after Git garbage collection", () => {
	const f = fixture();
	try {
		const base = snapshotSource(f.repo, f.store);
		writeFileSync(join(f.repo, "two.txt"), "child two\n");
		const child = snapshotSource(f.repo, f.store);
		writeFileSync(join(f.repo, "two.txt"), "base two\n");
		writeFileSync(join(f.repo, "one.txt"), "parent one\n");
		const plan = planSourceJoin(f.repo, base.commit, child.commit, f.store);
		if (plan.status !== "ready") assert.fail("join should be ready");
		f.git("gc", "--prune=now");
		applySourceJoin(plan);
		assert.equal(readFileSync(join(f.repo, "one.txt"), "utf8"), "parent one\n");
		assert.equal(readFileSync(join(f.repo, "two.txt"), "utf8"), "child two\n");
	} finally { rmSync(f.dir, { recursive: true, force: true }); }
});

it("a conflict applies none of the child's files and leaves parent staging intact", () => {
	const f = fixture();
	try {
		const base = snapshotSource(f.repo, f.store);
		writeFileSync(join(f.repo, "one.txt"), "child one\n"); writeFileSync(join(f.repo, "two.txt"), "child two\n");
		const child = snapshotSource(f.repo, f.store);
		writeFileSync(join(f.repo, "one.txt"), "parent one\n"); writeFileSync(join(f.repo, "two.txt"), "base two\n");
		f.git("add", "one.txt"); const index = f.index();
		const plan = planSourceJoin(f.repo, base.commit, child.commit, f.store);
		assert.equal(plan.status, "conflict");
		if (plan.status === "conflict") assert.match(plan.details, /one.txt/);
		assert.equal(readFileSync(join(f.repo, "one.txt"), "utf8"), "parent one\n");
		assert.equal(readFileSync(join(f.repo, "two.txt"), "utf8"), "base two\n");
		assert.deepEqual(f.index(), index);
	} finally { rmSync(f.dir, { recursive: true, force: true }); }
});

it("recovers partially applied owned files without discarding later unrelated work", () => {
	const f = fixture();
	try {
		const base = snapshotSource(f.repo, f.store);
		writeFileSync(join(f.repo, "two.txt"), "child two\n");
		writeFileSync(join(f.repo, "new[1].txt"), Buffer.from([0, 255, 128]));
		const child = snapshotSource(f.repo, f.store);
		writeFileSync(join(f.repo, "two.txt"), "base two\n"); rmSync(join(f.repo, "new[1].txt"));
		const plan = planSourceJoin(f.repo, base.commit, child.commit, f.store);
		if (plan.status !== "ready") assert.fail("join should be ready");
		writeBindingFile(plan.journalFile, { ...plan, state: "applying" });
		// Simulate interruption after one owned file was applied.
		writeFileSync(join(f.repo, "two.txt"), "child two\n");
		writeFileSync(join(f.repo, "one.txt"), "unrelated later work\n");
		applySourceJoin(plan);
		assert.equal(readFileSync(join(f.repo, "one.txt"), "utf8"), "unrelated later work\n");
		assert.deepEqual(readFileSync(join(f.repo, "new[1].txt")), Buffer.from([0, 255, 128]));
		assert.equal(JSON.parse(readFileSync(plan.journalFile, "utf8")).state, "integrated");
	} finally { rmSync(f.dir, { recursive: true, force: true }); }
});

it("an interrupted empty join never reverts unrelated parent changes", () => {
	const f = fixture();
	try {
		const base = snapshotSource(f.repo, f.store);
		const plan = planSourceJoin(f.repo, base.commit, base.commit, f.store);
		if (plan.status !== "ready") assert.fail("join should be ready");
		assert.deepEqual(plan.paths, []);
		writeBindingFile(plan.journalFile, { ...plan, state: "applying" });
		writeFileSync(join(f.repo, "one.txt"), "later work\n");
		applySourceJoin(plan);
		assert.equal(readFileSync(join(f.repo, "one.txt"), "utf8"), "later work\n");
	} finally { rmSync(f.dir, { recursive: true, force: true }); }
});
it("rejects a stale prepared join without overwriting edits made after preparation", () => {
	const f = fixture();
	try {
		const base = snapshotSource(f.repo, f.store);
		writeFileSync(join(f.repo, "two.txt"), "child two\n"); const child = snapshotSource(f.repo, f.store);
		writeFileSync(join(f.repo, "two.txt"), "base two\n");
		const plan = planSourceJoin(f.repo, base.commit, child.commit, f.store);
		assert.equal(plan.status, "ready"); if (plan.status !== "ready") assert.fail("join should be ready");
		writeFileSync(join(f.repo, "two.txt"), "new concurrent work\n");
		assert.throws(() => applySourceJoin(plan), /changed|stale/i);
		assert.equal(readFileSync(join(f.repo, "two.txt"), "utf8"), "new concurrent work\n");
	} finally { rmSync(f.dir, { recursive: true, force: true }); }
});
