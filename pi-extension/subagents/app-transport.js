import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { appCoreEnvironment } from "./app-core.js";
export class UnknownAppOutcome extends Error {
}
export class AppCommandError extends Error {
    reply;
    constructor(reply) { super(reply); this.reply = reply; }
}
/** Invoke the App window on the captured connection rather than its focused terminal. */
export function runApp(context, args) {
    if (context.appRoute) {
        let output;
        try {
            output = execFileSync(process.execPath, [fileURLToPath(new URL("./app-controller.js", import.meta.url))], {
                input: JSON.stringify({ route: context.appRoute, args }), encoding: "utf8", timeout: 40_000,
                maxBuffer: 16 * 1024 * 1024, stdio: ["pipe", "pipe", "pipe"], windowsHide: true,
            });
        }
        catch {
            throw new UnknownAppOutcome("The App controller returned no confirmed receipt.");
        }
        let reply;
        try {
            reply = JSON.parse(output);
        }
        catch {
            throw new UnknownAppOutcome("The App controller receipt is unreadable.");
        }
        if (reply?.ok !== true) {
            if (reply?.ok === false && !reply.uncertain && typeof reply.error === "string")
                throw new Error(reply.error);
            throw new UnknownAppOutcome(reply?.error || "The App controller outcome is unconfirmed.");
        }
        if (!reply.result || typeof reply.result !== "object")
            throw new UnknownAppOutcome("The App controller result is invalid.");
        if (typeof reply.result.error === "string")
            throw new AppCommandError(reply.result.error);
        return reply.result;
    }
    const env = appCoreEnvironment(context);
    let output;
    try {
        if (context.appSsh) {
            const route = context.appSsh;
            if (!/^(?:[A-Za-z0-9][A-Za-z0-9_.-]*@)?[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(route.target))
                throw new Error("Invalid SSH App target.");
            const script = `const cfg=${JSON.stringify({ ...route, args })};
const {execFileSync}=require("node:child_process");
const env={...process.env,HC_SESSION:cfg.session||"default"};
const routing={HC_SOCKET:cfg.coreSocketPath,HC_TERMINAL_SOCKET:cfg.coreSocketPath,HC_TERMINAL_ID:undefined,HC_SCOPE:undefined,XDG_STATE_HOME:cfg.stateHome,XDG_CONFIG_HOME:cfg.configHome,XDG_RUNTIME_DIR:cfg.runtimeDir,HERDR_APP_HOME:cfg.appHome};
for(const [key,value] of Object.entries(routing)){if(value===undefined)delete env[key];else env[key]=value;}
try{process.stdout.write(execFileSync(cfg.appCli||(process.platform==="win32"?"herdr-app.exe":"herdr-app"),cfg.args,{encoding:"utf8",env,timeout:40000,maxBuffer:16*1024*1024,windowsHide:true,stdio:["ignore","pipe","pipe"]}));}
catch(error){if(error.stdout)process.stdout.write(error.stdout);if(error.stderr)process.stderr.write(error.stderr);process.exitCode=1;}`;
            const encoded = Buffer.from(script).toString("base64");
            output = execFileSync("ssh", ["-T", "-o", "BatchMode=yes", "-o", "StrictHostKeyChecking=yes", "-o", "ForwardAgent=no", "-o", "ConnectTimeout=10", route.target, `node -e "eval(Buffer.from('${encoded}','base64').toString())"`], { encoding: "utf8", timeout: 60_000, maxBuffer: 16 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
        }
        else {
            output = execFileSync(context.appCli || (process.platform === "win32" ? "herdr-app.exe" : "herdr-app"), args, { encoding: "utf8", env, timeout: 40_000, maxBuffer: 16 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
        }
    }
    catch (error) {
        const stdout = error.stdout?.toString();
        if (!stdout?.trim())
            throw new UnknownAppOutcome(`The App command has no confirmed receipt: ${String(error)}`);
        output = stdout;
    }
    let response;
    try {
        response = JSON.parse(output);
    }
    catch {
        throw new UnknownAppOutcome("The App command receipt is unreadable.");
    }
    if (!response || typeof response !== "object")
        throw new UnknownAppOutcome("The App command receipt is invalid.");
    if (typeof response.error === "string")
        throw new AppCommandError(response.error);
    return response;
}
