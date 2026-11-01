import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { join } from "node:path";
import { Type } from "@sinclair/typebox";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/** Test-only timing and I/O witness; never used by the installed extension. */
export default function activeReplicaProbe(pi: ExtensionAPI, state: string): void {
	const child = process.env.PI_SUBAGENT_REPLICATION === "1";
	let timer: ReturnType<typeof setInterval> | undefined;
	let sampling = false;
	let bytes = 0;
	let maxGapMs = 0;
	let previous = performance.now();
	const readFile = fs.readFileSync;
	const read = fs.readSync;
	if (!child) {
		fs.readFileSync = ((...args: Parameters<typeof fs.readFileSync>) => {
			const result = readFile(...args);
			if (sampling) bytes += typeof result === "string" ? Buffer.byteLength(result) : result.length;
			return result;
		}) as typeof fs.readFileSync;
		fs.readSync = ((...args: Parameters<typeof fs.readSync>) => {
			const count = read(...args);
			if (sampling) bytes += count;
			return count;
		}) as typeof fs.readSync;
		syncBuiltinESMExports();
		pi.on("session_start", (_event, ctx) => {
			if (!timer) timer = setInterval(() => {
				const now = performance.now();
				if (sampling) maxGapMs = Math.max(maxGapMs, now - previous);
				previous = now;
			}, 20);
			fs.writeFileSync(join(state, "runtime.json"), JSON.stringify({ argv: process.argv, sessionDir: ctx.sessionManager.getSessionDir() }));
		});
		pi.registerCommand("sample-responsiveness", {
			description: "Measure three active supervision cycles",
			async handler(_args, ctx) {
				bytes = 0; maxGapMs = 0; previous = performance.now(); sampling = true;
				const start = performance.now();
				await new Promise(resolve => setTimeout(resolve, 3200));
				sampling = false;
				fs.writeFileSync(join(state, "metrics.json"), JSON.stringify({ bytes, maxGapMs, durationMs: performance.now() - start }));
				ctx.ui.notify("RESPONSIVENESS_SAMPLED", "info");
			},
		});
		pi.on("tool_result", (event) => {
			if (event.toolName === "replicate") pi.appendEntry("responsiveness-history", { text: "x".repeat(4 * 1024 * 1024) });
		});
	}
	pi.on("session_shutdown", () => {
		if (timer) clearInterval(timer);
		if (!child) { fs.readFileSync = readFile; fs.readSync = read; syncBuiltinESMExports(); }
	});
	pi.registerTool({
		name: "replication_probe", label: "Probe", description: "Hold an active replica", parameters: Type.Object({}),
		async execute() {
			pi.appendEntry("responsiveness-history", { text: "x".repeat(4 * 1024 * 1024) });
			fs.writeFileSync(join(state, `active-${process.pid}`), "ready");
			const deadline = Date.now() + 60_000;
			while (!fs.existsSync(join(state, "release"))) {
				if (Date.now() > deadline) throw new Error("active replica release timed out");
				await new Promise(resolve => setTimeout(resolve, 25));
			}
			return { content: [{ type: "text", text: "CAPABILITY_INHERITED" }], details: {} };
		},
	});
}
