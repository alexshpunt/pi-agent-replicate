import { spawn } from "node:child_process";
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "@sinclair/typebox";

/** Exercise the real no-session CLI startup check used before a self-reload. */
export default function reloadProbe(pi: ExtensionAPI): void {
	const key = Symbol.for("replica-reload-test.continuation");
	const state = globalThis as typeof globalThis & { [key]?: boolean };
	let requested: "reload" | "blocked" | undefined;
	pi.on("session_start", () => {
		if (!state[key]) return;
		delete state[key];
		pi.sendUserMessage("Return exactly REPLICA_AFTER_RELOAD", { deliverAs: "followUp" });
	});
	pi.on("agent_settled", () => {
		if (!requested) return;
		const blocked = requested === "blocked";
		requested = undefined;
		if (blocked) {
			pi.sendMessage({ customType: "pi-reload-self", content: "Return exactly REPLICA_AFTER_BLOCKED", display: false, details: { status: "blocked" } }, { triggerTurn: true, deliverAs: "followUp" });
			return;
		}
		state[key] = true;
		pi.sendUserMessage("/reload-probe", { deliverAs: "followUp", expandPromptTemplates: true });
	});
	pi.registerTool({
		name: "pi_extension_dev_reload_self", label: "Reload probe", description: "Schedule a test reload after this turn settles",
		parameters: Type.Object({ blocked: Type.Optional(Type.Boolean()) }),
		async execute(_id, args) {
			requested = args.blocked ? "blocked" : "reload";
			return { content: [{ type: "text", text: "Reload scheduled" }], details: { queued: true } };
		},
	});
	pi.registerCommand("reload-probe", {
		description: "Check startup without a session, then reload this test replica",
		async handler(_args, ctx) {
			const child = spawn(process.execPath, [
				process.argv[1], "--mode", "rpc", "--no-session", "--no-extensions",
				"--extension", fileURLToPath(new URL("../../../pi-extension/subagents/subagent-done.ts", import.meta.url)),
			], { cwd: ctx.cwd, env: process.env, stdio: ["pipe", "pipe", "pipe"] });
			let output = "";
			let errorOutput = "";
			const timer = setTimeout(() => child.kill("SIGTERM"), 15_000);
			child.stdout.setEncoding("utf8");
			child.stdout.on("data", chunk => {
				output += chunk;
				if (output.split("\n").some(line => {
					try { const row = JSON.parse(line); return row.id === "reload-probe" && row.success === true; } catch { return false; }
				})) child.stdin.end();
			});
			child.stderr.setEncoding("utf8");
			child.stderr.on("data", chunk => { errorOutput += chunk; });
			try {
				const closed = new Promise<number | null>((resolve, reject) => {
					child.once("error", reject);
					child.once("close", resolve);
				});
				child.stdin.write(JSON.stringify({ id: "reload-probe", type: "get_state" }) + "\n");
				const code = await closed;
				if (code !== 0) throw new Error(`Startup probe exited ${code}: ${errorOutput}\n${output}`);
				writeFileSync(join(process.env.PI_CODING_AGENT_DIR!, "reload-probe-result.json"), JSON.stringify({
					foreignCompletion: existsSync(process.env.PI_SUBAGENT_SESSION + ".exit"),
					output,
				}));
			} finally { clearTimeout(timer); }
			await ctx.reload();
		},
	});
}
