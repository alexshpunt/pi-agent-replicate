import { execFileSync, spawnSync } from "node:child_process";
import { join } from "node:path";
import { withLineageMutationGate } from "./lineage.ts";

/** Reserve a readable, unique branch and checkout name without moving parent HEAD or staging. */
export async function reserveReplicaBranch(cwd: string, title: string, base: string): Promise<string> {
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
	const git = (args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8", timeout: 10_000 });
	const gate = join(git(["rev-parse", "--path-format=absolute", "--git-common-dir"]).trim(), "replica-branches");
	const deadline = Date.now() + 5_000;
	for (;;) {
		try {
			return withLineageMutationGate(gate, () => {
				// Different origin/task pairs can flatten to the same Herdr directory.
				// Serialize both checks across all linked checkouts of this repository.
				const directory = (branch: string) => branch.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
				const occupied = new Set(git(["for-each-ref", "--format=%(refname:strip=2)", "refs/heads"]).trim().split("\n").map(directory));
				for (let number = 1; ; number++) {
					const branch = number === 1 ? stem : `${stem}-${number}`;
					if (occupied.has(directory(branch))) continue;
					const ref = `refs/heads/${branch}`;
					// Empty expected old value also guards against external Git writers.
					const created = spawnSync("git", ["update-ref", ref, base, ""], { cwd, encoding: "utf8", timeout: 10_000 });
					if (created.error) throw created.error;
					if (created.status === 0) return branch;
					if (!git(["for-each-ref", "--format=%(refname)", ref]).split("\n").includes(ref)) throw new Error(`Cannot reserve replica branch ${branch}: ${created.stderr.trim() || created.signal || "Git failed"}`);
				}
			});
		} catch (error) {
			if (!(error instanceof Error) || error.message !== "Durable state has an active mutation." || Date.now() >= deadline) throw error;
			await new Promise(resolve => setTimeout(resolve, 25));
		}
	}
}
