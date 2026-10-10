import { fork } from "node:child_process";
import { fileURLToPath } from "node:url";
/** Await costly durable host work without blocking Pi's input or model loop. */
export function runReplicaBackground(request) {
    return new Promise((resolve, reject) => {
        const child = fork(fileURLToPath(new URL("./replica-worker.js", import.meta.url)), [], {
            // A pane handoff must not signal the worker through the old terminal process group.
            detached: true, execArgv: [], stdio: ["ignore", "ignore", "pipe", "ipc"],
        });
        let stderr = "";
        let reply;
        let failure;
        child.stderr?.on("data", (chunk) => { stderr = (stderr + String(chunk)).slice(-8192); });
        child.on("error", reject);
        child.on("message", (message) => {
            if (message.error)
                failure = new Error(message.error);
            else
                reply = message.result;
        });
        child.on("exit", (code, signal) => {
            if (failure)
                reject(failure);
            else if (code === 0 && reply)
                resolve(reply);
            else
                reject(new Error(`Replica host worker exited (${signal ?? code}): ${stderr}`));
        });
        child.send(request, (error) => { if (error)
            reject(error); });
    });
}
