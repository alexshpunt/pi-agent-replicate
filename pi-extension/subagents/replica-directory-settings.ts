import { mkdirSync, readFileSync, writeFileSync, renameSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import { getAgentDir, type ExtensionAPI } from "@earendil-works/pi-coding-agent";

export type ReplicaDirectoryMode = "worktree" | "shared";
export type ReplicaDirectoryScope = "project" | "global";
export interface ReplicaDirectorySetting { mode: ReplicaDirectoryMode; source: ReplicaDirectoryScope | "default" }

const fileFor = (scope: ReplicaDirectoryScope, cwd: string) =>
	scope === "project" ? join(cwd, ".pi", "replicate.json") : join(getAgentDir(), "replicate.json");

function readModeFile(file: string): ReplicaDirectoryMode | undefined {
	let raw: string;
	try { raw = readFileSync(file, "utf8"); }
	catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
		throw error;
	}
	const value = JSON.parse(raw);
	if (!value || (value.directoryMode !== "worktree" && value.directoryMode !== "shared")) {
		throw new Error("Invalid replica directory mode in " + file);
	}
	return value.directoryMode;
}

/** Resolve the mode for new replicas: the project setting, then the global setting, then the shared directory. */
export function resolveReplicaDirectoryMode(cwd: string): ReplicaDirectorySetting {
	const project = readModeFile(fileFor("project", cwd));
	if (project) return { mode: project, source: "project" };
	const global = readModeFile(fileFor("global", cwd));
	return global ? { mode: global, source: "global" } : { mode: "shared", source: "default" };
}

export function readReplicaDirectoryMode(cwd: string): ReplicaDirectoryMode {
	return resolveReplicaDirectoryMode(cwd).mode;
}

function saveMode(scope: ReplicaDirectoryScope, cwd: string, mode: ReplicaDirectoryMode): void {
	const file = fileFor(scope, cwd), temp = file + "." + randomUUID() + ".tmp";
	mkdirSync(dirname(file), { recursive: true });
	try {
		writeFileSync(temp, JSON.stringify({ directoryMode: mode }, null, 2) + "\n", { flag: "wx" });
		renameSync(temp, file);
	} finally { rmSync(temp, { force: true }); }
}

const describeMode = (mode: ReplicaDirectoryMode) => mode === "shared" ? "the shared directory" : "a separate worktree";
const describeSource = (source: ReplicaDirectorySetting["source"]) =>
	source === "project" ? "this project" : source === "global" ? "all projects" : "default";
const USAGE = "Use /replica-directory [--global] shared|worktree.";

export function registerReplicaDirectoryCommand(pi: ExtensionAPI): void {
	pi.registerCommand("replica-directory", {
		description: "Choose where new replicas work, for this project or with --global for all projects",
		handler: async (args, ctx) => {
			const words = args.trim().split(/\s+/).filter(Boolean);
			const global = words.includes("--global");
			const rest = words.filter(word => word !== "--global");
			if (rest.length > 1) {
				ctx.ui.notify(USAGE, "error");
				return;
			}
			let mode = rest[0] ?? "";
			let scope: ReplicaDirectoryScope = global ? "global" : "project";
			if (!mode && ctx.hasUI) {
				const current = resolveReplicaDirectoryMode(ctx.cwd);
				const choices = (global ? ["global"] as const : ["project", "global"] as const).flatMap(target =>
					(["worktree", "shared"] as const).map(value => ({ label: `${value} (${describeSource(target)})`, scope: target, mode: value })));
				const label = await ctx.ui.select(`Replica directory (current: ${current.mode}, ${describeSource(current.source)})`, choices.map(choice => choice.label));
				const choice = choices.find(item => item.label === label);
				if (choice) { mode = choice.mode; scope = choice.scope; }
			}
			if (!mode) return;
			if (mode !== "shared" && mode !== "worktree") {
				ctx.ui.notify(USAGE, "error");
				return;
			}
			saveMode(scope, ctx.cwd, mode);
			if (scope === "project") {
				ctx.ui.notify(`New replicas in this project will use ${describeMode(mode)}.`, "info");
				return;
			}
			const effective = resolveReplicaDirectoryMode(ctx.cwd);
			ctx.ui.notify(effective.source === "project" && effective.mode !== mode
				? `New replicas will use ${describeMode(mode)} in all projects, but this project overrides it with ${describeMode(effective.mode)} in .pi/replicate.json.`
				: `New replicas will use ${describeMode(mode)} in all projects without their own setting.`, "info");
		},
	});
}
