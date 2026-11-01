import { mkdirSync, readFileSync, writeFileSync, renameSync, rmSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export type ReplicaDirectoryMode = "worktree" | "shared";
const fileFor = (cwd: string) => join(cwd, ".pi", "replicate.json");

export function readReplicaDirectoryMode(cwd: string): ReplicaDirectoryMode {
	let raw: string;
	try { raw = readFileSync(fileFor(cwd), "utf8"); }
	catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return "worktree";
		throw error;
	}
	const value = JSON.parse(raw);
	if (!value || (value.directoryMode !== "worktree" && value.directoryMode !== "shared")) {
		throw new Error("Invalid replica directory mode in " + fileFor(cwd));
	}
	return value.directoryMode;
}

function saveMode(cwd: string, mode: ReplicaDirectoryMode): void {
	const dir = join(cwd, ".pi");
	mkdirSync(dir, { recursive: true });
	const file = fileFor(cwd), temp = file + "." + randomUUID() + ".tmp";
	try {
		writeFileSync(temp, JSON.stringify({ directoryMode: mode }, null, 2) + "\n", { flag: "wx" });
		renameSync(temp, file);
	} finally { rmSync(temp, { force: true }); }
}

export function registerReplicaDirectoryCommand(pi: ExtensionAPI): void {
	pi.registerCommand("replica-directory", {
		description: "Choose where new replicas work for this project",
		handler: async (args, ctx) => {
			let mode = args.trim();
			if (!mode && ctx.hasUI) {
				const current = readReplicaDirectoryMode(ctx.cwd);
				mode = await ctx.ui.select(`Replica directory (current: ${current})`, ["worktree", "shared"]) ?? "";
			}
			if (!mode) return;
			if (mode !== "shared" && mode !== "worktree") {
				ctx.ui.notify("Use /replica-directory shared or /replica-directory worktree.", "error");
				return;
			}
			saveMode(ctx.cwd, mode);
			ctx.ui.notify(`New replicas will use ${mode === "shared" ? "the shared directory" : "a separate worktree"}.`, "info");
		},
	});
}
