/// <reference types="node" />
import { execFileSync } from "node:child_process";
export function inHerdrApp() {
    return !!process.env.HC_TERMINAL_ID?.trim();
}
export function appCore(args, text = false) {
    const env = {
        ...process.env
    };
    delete env.HC_SCOPE;
    if (env.HC_SOCKET && env.HC_TERMINAL_SOCKET && env.HC_SOCKET !== env.HC_TERMINAL_SOCKET) throw new Error("Conflicting App core sockets.");
    const output = execFileSync("hc", args, {
        env,
        encoding: "utf8",
        timeout: 15_000,
        stdio: [
            "ignore",
            "pipe",
            "pipe"
        ]
    });
    return text ? output : JSON.parse(output);
}
export function currentAppPane() {
    const id = process.env.HC_TERMINAL_ID;
    if (!id) throw new Error("No native App terminal.");
    const terminal = appCore([
        "get",
        id
    ]);
    if (terminal.address !== id || terminal.state !== "live" || typeof terminal.labels?.["herdr.space"] !== "string" || !terminal.labels["herdr.space"] || typeof terminal.labels?.["herdr.tab"] !== "string" || !terminal.labels["herdr.tab"]) {
        throw new Error("The current core terminal has no live App ownership.");
    }
    return {
        pane_id: id,
        tab_id: terminal.labels["herdr.tab"],
        workspace_id: terminal.labels["herdr.space"]
    };
}

