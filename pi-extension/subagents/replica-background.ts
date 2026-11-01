import { fork } from "node:child_process";
import { fileURLToPath } from "node:url";
import type { ReplicaCompletion, ReplicaWork } from "./replica-work.ts";
import type { SessionLocation } from "./session-binding.ts";

/** One host operation. No model or Pi runtime is loaded in the worker. */
export type ReplicaBackgroundRequest =
	| { operation: "complete"; file: string; cwd: string; sessionFile: string; completion: ReplicaCompletion; parent?: SessionLocation }
	| { operation: "cleanup"; file: string; parentCwd: string; surface: string; child?: { rootDir: string; nodeId: string } };
export interface ReplicaBackgroundResult {
	work?: ReplicaWork;
	cleaned?: boolean;
}

/** Await costly durable host work without blocking Pi's input or model loop. */
export function runReplicaBackground(request: ReplicaBackgroundRequest): Promise<ReplicaBackgroundResult> {
	return new Promise<ReplicaBackgroundResult>((resolve, reject) => {
		const child = fork(fileURLToPath(new URL("./replica-worker.js", import.meta.url)), [], {
			// A pane handoff must not signal the worker through the old terminal process group.
			detached: true, execArgv: [], stdio: ["ignore", "ignore", "pipe", "ipc"],
		});
		let stderr = "";
		let reply: ReplicaBackgroundResult | undefined;
		let failure: Error | undefined;
		child.stderr?.on("data", (chunk) => { stderr = (stderr + String(chunk)).slice(-8192); });
		child.on("error", reject);
		child.on("message", (message: { result?: ReplicaBackgroundResult; error?: string }) => {
			if (message.error) failure = new Error(message.error);
			else reply = message.result;
		});
		child.on("exit", (code, signal) => {
			if (failure) reject(failure);
			else if (code === 0 && reply) resolve(reply);
			else reject(new Error(`Replica host worker exited (${signal ?? code}): ${stderr}`));
		});
		child.send(request, (error) => { if (error) reject(error); });
	});
}
