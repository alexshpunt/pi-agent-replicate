import { execFileSync, spawnSync } from "node:child_process";

/** Reserve a readable, unique branch at the snapshot without moving parent HEAD or staging. */
export function reserveReplicaBranch(cwd: string, title: string, base: string): string {
	const [task, ...origins] = title.split(" ← ");
	const cyrillic: Record<string, string> = {
		а: "a", б: "b", в: "v", г: "g", д: "d", е: "e", ё: "yo", ж: "zh", з: "z", и: "i", й: "i",
		к: "k", л: "l", м: "m", н: "n", о: "o", п: "p", р: "r", с: "s", т: "t", у: "u", ф: "f",
		х: "kh", ц: "ts", ч: "ch", ш: "sh", щ: "shch", ъ: "", ы: "y", ь: "", э: "e", ю: "yu", я: "ya",
	};
	// Herdr drops non-ASCII characters from its default checkout directory.
	const origin = origins.join("-").normalize("NFKC").toLowerCase()
		.replace(/[а-яё]/g, character => cyrillic[character])
		.normalize("NFKD").replace(/\p{M}/gu, "")
		.replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "session";
	const stem = `replica/${origin}/${task}`;
	for (let number = 1; ; number++) {
		const branch = number === 1 ? stem : `${stem}-${number}`;
		const ref = `refs/heads/${branch}`;
		// An empty expected old value requires the ref to be absent. Git arbitrates
		// simultaneous launches from separate sessions and linked worktrees.
		const created = spawnSync("git", ["update-ref", ref, base, ""], { cwd, encoding: "utf8", timeout: 10_000 });
		if (created.error) throw created.error;
		if (created.status === 0) return branch;
		const existing = execFileSync("git", ["for-each-ref", "--format=%(refname)", ref], { cwd, encoding: "utf8", timeout: 10_000 });
		if (!existing.split("\n").includes(ref)) throw new Error(`Cannot reserve replica branch ${branch}: ${created.stderr.trim() || created.signal || "Git failed"}`);
	}
}
