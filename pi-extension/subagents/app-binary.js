import { execFileSync } from "node:child_process";
import { accessSync, constants } from "node:fs";
import { homedir, release } from "node:os";
import { posix, win32 } from "node:path";
function systemHost() {
    return {
        platform: process.platform,
        env: process.env,
        wsl: process.platform === "linux" && /microsoft/i.test(release()),
        isExecutable(file) {
            try {
                accessSync(file, process.platform === "win32" ? constants.F_OK : constants.X_OK);
                return true;
            }
            catch {
                return false;
            }
        },
        run(command, args) {
            return execFileSync(command, args, { encoding: "utf8", timeout: 10_000, stdio: ["ignore", "pipe", "ignore"], windowsHide: true });
        },
        home: homedir,
    };
}
const WINDOWS_POWERSHELL = String.raw `C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe`;
function onPath(host, names) {
    const windows = host.platform === "win32";
    const path = windows ? win32 : posix;
    for (const dir of (host.env.PATH ?? host.env.Path ?? "").split(windows ? ";" : ":")) {
        if (!dir)
            continue;
        for (const name of names) {
            const candidate = path.join(dir, name);
            if (host.isExecutable(candidate))
                return candidate;
        }
    }
    return undefined;
}
/** The Windows PowerShell that WSL can start, found on PATH or through the Windows system folder. */
function windowsPowerShell(host) {
    const named = onPath(host, ["powershell.exe", "pwsh.exe"]);
    if (named)
        return named;
    try {
        const translated = host.run("wslpath", ["-u", WINDOWS_POWERSHELL]).trim();
        return translated && host.isExecutable(translated) ? translated : undefined;
    }
    catch {
        return undefined;
    }
}
/** The installer's per-user folder, as Windows itself reports it. */
function installedWindowsApp(host) {
    const tail = ["Programs", "herdr-app", "herdr-app.exe"];
    if (host.platform === "win32") {
        const local = host.env.LOCALAPPDATA || win32.join(host.home(), "AppData", "Local");
        const file = win32.join(local, ...tail);
        return host.isExecutable(file) ? file : undefined;
    }
    if (!host.wsl)
        return undefined;
    const powershell = windowsPowerShell(host);
    if (!powershell)
        return undefined;
    try {
        const local = host.run(powershell, ["-NoProfile", "-NonInteractive", "-Command", '[Environment]::GetFolderPath("LocalApplicationData")']).trim();
        if (!local)
            return undefined;
        const file = host.run("wslpath", ["-u", win32.join(local, ...tail)]).trim();
        return file && host.isExecutable(file) ? file : undefined;
    }
    catch {
        return undefined;
    }
}
/** Variables that choose the App program and machine; a child terminal does not inherit them. */
export const APP_ENVIRONMENT_VARIABLES = ["PI_HERDR_APP_CLI", "HERDR_APP_BIN", "PI_HERDR_APP_MACHINE"];
/** The ones set in this process, including an empty machine name, to pass on to a child. */
export function forwardedAppEnvironment(env = process.env) {
    const forwarded = {};
    for (const name of APP_ENVIRONMENT_VARIABLES)
        if (env[name] !== undefined)
            forwarded[name] = env[name];
    return forwarded;
}
export function defaultAppCliName(platform = process.platform) {
    return platform === "win32" ? "herdr-app.exe" : "herdr-app";
}
let cached;
/**
 * Find the Herdr App command-line program for this terminal. An explicit path wins, then
 * `PI_HERDR_APP_CLI` and the app's own `HERDR_APP_BIN`, then `PATH`, then the Windows
 * installer's folder (reached through `wslpath` from WSL). Without any of them the plain name is
 * returned so that starting it fails with a clear error.
 */
export function resolveAppCli(explicit, host) {
    const given = host ?? systemHost();
    const named = explicit || given.env.PI_HERDR_APP_CLI || given.env.HERDR_APP_BIN;
    if (named)
        return named;
    const key = host ? undefined : JSON.stringify([given.env.PATH, given.env.Path, given.env.LOCALAPPDATA]);
    if (key !== undefined && cached?.key === key)
        return cached.value;
    const names = given.platform === "win32" ? ["herdr-app.exe"] : given.wsl ? ["herdr-app", "herdr-app.exe"] : ["herdr-app"];
    const found = onPath(given, names) ?? installedWindowsApp(given);
    if (!found)
        return defaultAppCliName(given.platform);
    if (key !== undefined)
        cached = { key, value: found };
    return found;
}
