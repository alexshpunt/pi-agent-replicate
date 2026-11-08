export interface WindowsLaunch {
  cwd: string;
  executable: string;
  args: string[];
  env: Record<string, string>;
  launcherPidFromShell?: boolean;
}

function quote(value: string): string { return `'${value.replace(/'/g, "''")}'`; }

// Windows argv parsing doubles backslashes before a quote and at the end.
function nativeArg(value: string): string {
  return '"' + value.replace(/(\\*)"/g, (_match, slashes: string) => slashes + slashes + '\\"').replace(/(\\*)$/, (_match, slashes: string) => slashes + slashes) + '"';
}

/** A native PowerShell script; inputs are literals, never shell fragments. */
export function windowsLaunchScript(launch: WindowsLaunch): string {
  const assignments = Object.entries(launch.env).map(([key, value]) => {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) throw new Error("Invalid environment variable name.");
    return `$env:${key} = ${quote(value)}`;
  });
  return [
    "$ErrorActionPreference = 'Stop'",
    `Set-Location -LiteralPath ${quote(launch.cwd)}`,
    ...assignments,
    ...(launch.launcherPidFromShell ? ["$env:PI_SUBAGENT_LAUNCHER_PID = [string]$PID"] : []),
    "$start = New-Object System.Diagnostics.ProcessStartInfo",
    `$start.FileName = ${quote(launch.executable)}`,
    `$start.WorkingDirectory = ${quote(launch.cwd)}`,
    `$start.Arguments = ${quote(launch.args.map(nativeArg).join(" "))}`,
    "$start.UseShellExecute = $false",
    "$process = [System.Diagnostics.Process]::Start($start)",
    "$process.WaitForExit()",
    "$status = $process.ExitCode",
    "Write-Output ('__SUBAGENT_DONE_' + $status + '__')",
    "exit $status",
    "",
  ].join("\r\n");
}

/** The invocation contains only base64, so both cmd and PowerShell can run it. */
export function windowsScriptInvocation(scriptPath: string): string {
  const command = `$ProgressPreference = 'SilentlyContinue'; & ${quote(scriptPath)}`;
  const encoded = Buffer.from(command, "utf16le").toString("base64");
  return `powershell.exe -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -EncodedCommand ${encoded}`;
}
