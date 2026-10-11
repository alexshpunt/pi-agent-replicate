import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it } from "node:test";
import { reserveReplicaBranch } from "../pi-extension/subagents/replica-branch.ts";

function repository() {
	const cwd = mkdtempSync(join(tmpdir(), "replica-branch-"));
	const git = (...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
	git("init", "-q");
	git("-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "--allow-empty", "-qm", "Base");
	return { cwd, git, base: git("rev-parse", "HEAD") };
}

it("names a replica branch after its origin and supplied task without changing parent work", () => {
	const { cwd, git, base } = repository();
	try {
		writeFileSync(join(cwd, "staged.txt"), "staged");
		git("add", "staged.txt");
		writeFileSync(join(cwd, "staged.txt"), "working");
		const before = git("ls-files", "--stage");
		const branch = reserveReplicaBranch(cwd, "check-auth-risks ← Настройки / API: v2", base);
		assert.equal(branch, "replica/nastroiki-api-v2/check-auth-risks");
		git("check-ref-format", "--branch", branch);
		assert.equal(git("rev-parse", branch), base);
		assert.equal(git("rev-parse", "HEAD"), base);
		assert.equal(git("ls-files", "--stage"), before);
		assert.equal(git("diff", "--", "staged.txt").includes("+working"), true);
	} finally { rmSync(cwd, { recursive: true, force: true }); }
});

it("numbers repeated names without reusing an existing branch or its commit", () => {
	const { cwd, git, base } = repository();
	try {
		const title = "check-auth-risks ← Settings";
		assert.equal(reserveReplicaBranch(cwd, title, base), "replica/settings/check-auth-risks");
		git("-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "--allow-empty", "-qm", "Later");
		const later = git("rev-parse", "HEAD");
		assert.equal(reserveReplicaBranch(cwd, title, later), "replica/settings/check-auth-risks-2");
		assert.equal(reserveReplicaBranch(cwd, title, later), "replica/settings/check-auth-risks-3");
		assert.equal(git("rev-parse", "replica/settings/check-auth-risks"), base);
	} finally { rmSync(cwd, { recursive: true, force: true }); }
});

it("keeps nested origins readable and makes punctuation-only origins safe", () => {
	const { cwd, git, base } = repository();
	try {
		assert.equal(reserveReplicaBranch(cwd, "check-types ← check-owner ← Settings", base), "replica/check-owner-settings/check-types");
		const branch = reserveReplicaBranch(cwd, "check-types ← ../@{???}.lock", base);
		git("check-ref-format", "--branch", branch);
		assert.equal(branch, "replica/lock/check-types");
		assert.equal(reserveReplicaBranch(cwd, "check-types ← 💥", base), "replica/session/check-types");
	} finally { rmSync(cwd, { recursive: true, force: true }); }
});

it("gives concurrent same-name replicas separate branches", { timeout: 15_000 }, async () => {
	const { cwd, base } = repository();
	try {
		const module = new URL("../pi-extension/subagents/replica-branch.ts", import.meta.url).href;
		const attempts = Array.from({ length: 4 }, () => new Promise<string>((resolve, reject) => {
			const child = spawn(process.execPath, ["--experimental-strip-types", "--input-type=module", "-e",
				`import {reserveReplicaBranch} from ${JSON.stringify(module)}; console.log(reserveReplicaBranch(${JSON.stringify(cwd)}, "check-tests ← Settings", ${JSON.stringify(base)}));`]);
			let output = "", errors = "";
			child.stdout.on("data", data => { output += data; });
			child.stderr.on("data", data => { errors += data; });
			child.on("error", reject);
			child.on("exit", code => code === 0 ? resolve(output.trim()) : reject(new Error(errors)));
		}));
		assert.deepEqual((await Promise.all(attempts)).sort(), [
			"replica/settings/check-tests", "replica/settings/check-tests-2",
			"replica/settings/check-tests-3", "replica/settings/check-tests-4",
		]);
	} finally { rmSync(cwd, { recursive: true, force: true }); }
});
