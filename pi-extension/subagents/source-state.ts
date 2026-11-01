import { execFileSync, spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { closeSync, existsSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { writeBindingFile } from "./session-binding.ts";

/** A GC-protected source checkpoint; it never advances the caller's branch. */
export interface SourceSnapshot {
	repoDir: string;
	commonDir: string;
	head: string;
	indexHash: string;
	commit: string;
	tree: string;
	ref: string;
}

/** A clean three-way result, not yet applied to the parent's working files. */
export interface SourceJoinReady {
	status: "ready";
	before: SourceSnapshot;
	mergedTree: string;
	paths: string[];
	storeDir: string;
	journalFile: string;
}

/** Git conflicts are reported without checking conflict markers into the parent. */
export interface SourceJoinConflict {
	status: "conflict";
	details: string;
}
export type SourceJoin = SourceJoinReady | SourceJoinConflict;

type JoinJournal = SourceJoinReady & { state: "prepared" | "applying" | "integrated" };

function gitEnvironment(extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
	const env: NodeJS.ProcessEnv = { ...process.env, GIT_OPTIONAL_LOCKS: "0", ...extra };
	// The explicit cwd, not a launcher's inherited Git routing, owns this operation.
	delete env.GIT_DIR; delete env.GIT_WORK_TREE;
	delete env.GIT_OBJECT_DIRECTORY; delete env.GIT_ALTERNATE_OBJECT_DIRECTORIES;
	if (!extra.GIT_INDEX_FILE) delete env.GIT_INDEX_FILE;
	return env;
}
function git(cwd: string, args: string[], extra?: NodeJS.ProcessEnv, input?: string | Buffer): string {
	return execFileSync("git", ["--literal-pathspecs", ...args], { cwd, env: gitEnvironment(extra), input, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
}
function indexHash(cwd: string): string {
	const path = git(cwd, ["rev-parse", "--path-format=absolute", "--git-path", "index"]).trim();
	return createHash("sha256").update(existsSync(path) ? readFileSync(path) : "missing index").digest("hex");
}
function rejectUnsupportedIndex(cwd: string, extra?: NodeJS.ProcessEnv): void {
	if (git(cwd, ["ls-files", "-v", "-z"], extra).split("\0").some((entry) => /^(?:S|[a-z]) /.test(entry))) throw new Error("Replica snapshots do not support sparse or assume-unchanged index entries.");
	const entries = git(cwd, ["ls-files", "--stage", "-z"], extra).split("\0");
	if (entries.some((entry) => entry.startsWith("160000 "))) throw new Error("Replica snapshots do not support submodules or nested Git repositories.");
	if (git(cwd, ["ls-files", "--unmerged", "-z"], extra)) throw new Error("Replica snapshots require an index without unresolved conflicts.");
}

/** Herdr allocates linked worktrees through the repository's main checkout. */
export function sourceRepositoryAnchor(cwd: string): string {
	const rows = git(cwd, ["worktree", "list", "--porcelain", "-z"]).split("\0");
	const first = rows.slice(0, rows.indexOf(""));
	if (!first[0]?.startsWith("worktree ") || first.includes("bare")) throw new Error("Replication requires a main non-bare checkout for Herdr allocation.");
	const anchor = first[0].slice("worktree ".length);
	if (realpathSync(git(anchor, ["rev-parse", "--path-format=absolute", "--git-common-dir"]).trim()) !== realpathSync(git(cwd, ["rev-parse", "--path-format=absolute", "--git-common-dir"]).trim())) throw new Error("Replica repository anchor mismatch.");
	return anchor;
}
/** Capture tracked working content and nonignored new files through a private index. */
export function snapshotSource(cwd: string, storeDir: string): SourceSnapshot {
	const repoDir = realpathSync(git(cwd, ["rev-parse", "--show-toplevel"]).trim());
	const commonDir = realpathSync(git(repoDir, ["rev-parse", "--path-format=absolute", "--git-common-dir"]).trim());
	const relativeStore = relative(repoDir, resolve(storeDir));
	if (!relativeStore) throw new Error("Replica snapshot storage cannot be the source repository itself.");
	if (relativeStore && relativeStore !== ".." && !relativeStore.startsWith(".." + sep) && !isAbsolute(relativeStore)) {
		const ignored = spawnSync("git", ["check-ignore", "-q", "--", relativeStore], { cwd: repoDir, env: gitEnvironment() });
		if (ignored.status !== 0) throw new Error("Replica snapshot storage inside the repository must be Git-ignored.");
	}
	const head = git(repoDir, ["rev-parse", "--verify", "HEAD^{commit}"]).trim();
	const originalIndex = indexHash(repoDir);
	rejectUnsupportedIndex(repoDir);
	mkdirSync(storeDir, { recursive: true });
	const id = randomUUID(), privateIndex = join(resolve(storeDir), `snapshot-${id}.index`);
	const env = { GIT_INDEX_FILE: privateIndex };
	try {
		git(repoDir, ["read-tree", head], env);
		// Newly staged paths are tracked too, even when ignore rules match them.
		git(repoDir, ["update-index", "-z", "--index-info"], env, git(repoDir, ["ls-files", "--stage", "-z"]));
		git(repoDir, ["add", "-A", "--", "."], env);
		rejectUnsupportedIndex(repoDir, env);
		const tree = git(repoDir, ["write-tree"], env).trim();
		// Detect a source edit racing the snapshot instead of launching from mixed reads.
		git(repoDir, ["add", "-A", "--", "."], env);
		if (git(repoDir, ["write-tree"], env).trim() !== tree || git(repoDir, ["rev-parse", "HEAD"]).trim() !== head || indexHash(repoDir) !== originalIndex) {
			throw new Error("Source changed while taking the replica snapshot.");
		}
		const commit = git(repoDir, ["commit-tree", tree, "-p", head], {
			GIT_AUTHOR_NAME: "Pi replica host", GIT_AUTHOR_EMAIL: "replica@localhost",
			GIT_COMMITTER_NAME: "Pi replica host", GIT_COMMITTER_EMAIL: "replica@localhost",
		}, "Replica source checkpoint\n").trim();
		const ref = `refs/pi-replicas/snapshots/${id}`;
		git(repoDir, ["update-ref", ref, commit]);
		return { repoDir, commonDir, head, indexHash: originalIndex, commit, tree, ref };
	} finally {
		rmSync(privateIndex, { force: true }); rmSync(`${privateIndex}.lock`, { force: true });
	}
}

/** Compute child delta against the exact fork basis without changing any parent files. */
export function planSourceJoin(cwd: string, baseCommit: string, childCommit: string, storeDir: string): SourceJoin {
	const before = snapshotSource(cwd, storeDir);
	const result = spawnSync("git", ["merge-tree", "--write-tree", `--merge-base=${baseCommit}`, before.commit, childCommit], {
		cwd: before.repoDir, env: gitEnvironment(), encoding: "utf8", maxBuffer: 64 * 1024 * 1024,
	});
	if (result.error) throw result.error;
	if (result.status === 1) return { status: "conflict", details: result.stdout };
	if (result.status !== 0) throw new Error(`Git could not inspect the replica join: ${result.stderr || result.stdout}`);
	const mergedTree = result.stdout.trim();
	if (!/^[a-f0-9]{40,64}$/.test(mergedTree)) throw new Error("Git returned an invalid merged tree.");
	const paths = git(before.repoDir, ["diff", "--no-renames", "--name-only", "-z", before.tree, mergedTree]).split("\0").filter(Boolean);
	const id = randomUUID();
	// A saved plan must keep its merged tree alive until crash recovery applies it.
	git(before.repoDir, ["update-ref", `refs/pi-replicas/joins/${id}`, mergedTree]);
	const plan: SourceJoinReady = { status: "ready", before, mergedTree, paths, storeDir: resolve(storeDir), journalFile: join(resolve(storeDir), `join-${id}.json`) };
	writeBindingFile(plan.journalFile, { ...plan, state: "prepared" } satisfies JoinJournal);
	return plan;
}

function treePaths(cwd: string, tree: string): Map<string, string> {
	const result = new Map<string, string>();
	for (const entry of git(cwd, ["ls-tree", "-r", "-z", tree]).split("\0").filter(Boolean)) {
		const tab = entry.indexOf("\t");
		result.set(entry.slice(tab + 1), entry.slice(0, tab));
	}
	return result;
}

/** Apply or recover owned files without touching staging; validate the receiver again before writing. */
export function applySourceJoin(plan: SourceJoinReady, validateParent: () => void = () => {}): void {
	const journal = JSON.parse(readFileSync(plan.journalFile, "utf8")) as JoinJournal;
	if (journal.before.commit !== plan.before.commit || journal.mergedTree !== plan.mergedTree) throw new Error("Replica join journal does not match its plan.");
	if (journal.state === "integrated") return;
	const current = snapshotSource(plan.before.repoDir, plan.storeDir);
	if (current.commonDir !== plan.before.commonDir || current.head !== plan.before.head || current.indexHash !== plan.before.indexHash) {
		throw new Error("Parent Git identity or staging changed since the join was prepared.");
	}
	if (journal.state === "prepared" && current.tree !== plan.before.tree) throw new Error("Parent source changed since the join was prepared.");
	if (journal.state === "applying") {
		const old = treePaths(current.repoDir, plan.before.tree), after = treePaths(current.repoDir, plan.mergedTree), now = treePaths(current.repoDir, current.tree);
		for (const path of plan.paths) {
			if (now.get(path) !== old.get(path) && now.get(path) !== after.get(path)) throw new Error(`Parent source changed during interrupted join: ${path}`);
		}
	}
	// Limit recovery to owned paths; unrelated work written after application must survive.
	const patch = plan.paths.length ? git(current.repoDir, ["diff", "--binary", "--full-index", "--no-ext-diff", "--no-textconv", "--no-renames", current.tree, plan.mergedTree, "--", ...plan.paths]) : "";
	validateParent();
	writeBindingFile(plan.journalFile, { ...plan, state: "applying" } satisfies JoinJournal);
	if (patch) {
		git(current.repoDir, ["-c", "apply.ignoreWhitespace=no", "apply", "--check", "--binary", "--whitespace=nowarn", "-"], undefined, patch);
		validateParent();
		git(current.repoDir, ["-c", "apply.ignoreWhitespace=no", "apply", "--binary", "--whitespace=nowarn", "-"], undefined, patch);
	}
	const verified = snapshotSource(current.repoDir, plan.storeDir);
	const expected = treePaths(current.repoDir, plan.mergedTree), actual = treePaths(current.repoDir, verified.tree);
	if (plan.paths.some((path) => actual.get(path) !== expected.get(path)) || verified.indexHash !== plan.before.indexHash || verified.head !== plan.before.head) {
		throw new Error("Replica join could not verify its applied files; saved work is retained.");
	}
	// Persist changed files and directory entries before publishing durable integration.
	const directories = new Set<string>([current.repoDir]);
	for (const path of plan.paths) {
		const absolute = join(current.repoDir, path);
		if (existsSync(absolute) && lstatSync(absolute).isFile()) {
			const fd = openSync(absolute, "r");
			try { fsyncSync(fd); } finally { closeSync(fd); }
		}
		for (let directory = dirname(absolute); directory !== current.repoDir; directory = dirname(directory)) {
			if (existsSync(directory)) directories.add(directory);
		}
	}
	for (const directory of directories) {
		const fd = openSync(directory, "r");
		try { fsyncSync(fd); } finally { closeSync(fd); }
	}
	writeBindingFile(plan.journalFile, { ...plan, state: "integrated" } satisfies JoinJournal);
}
