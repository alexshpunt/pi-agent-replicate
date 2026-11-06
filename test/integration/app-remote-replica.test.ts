import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, readlinkSync, rmdirSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { test } from "node:test";

async function until<T>(observe: () => T | undefined, label: string, timeout = 90_000): Promise<T> {
  const end = Date.now() + timeout;
  while (Date.now() < end) { const value = observe(); if (value !== undefined) return value; await new Promise(resolve => setTimeout(resolve, 100)); }
  throw new Error(label);
}
const json = (file: string) => JSON.parse(readFileSync(file, "utf8"));

for (const transport of ["controller", "ssh"] as const) test(`native remote replica joins through the ${transport} App route before its parent returns`, { timeout: 240_000 }, async () => {
  const runRoot = process.env.PI_INTEGRATION_HERDR_RUN_DIR!;
  const teleport = process.env.PI_INTEGRATION_TELEPORT_SOURCE!, laptopTeleport = process.env.PI_TEST_LAPTOP_SOURCE!;
  const laptopReplica = process.env.PI_INTEGRATION_LAPTOP_REPLICA_SOURCE!, laptopRoot = process.env.PI_TEST_LAPTOP_ROOT!;
  assert.ok(runRoot?.includes("/.agents/tmp/app-integration-"));
  assert.ok(teleport && laptopTeleport && laptopReplica && laptopRoot?.includes("/.tmp/twohost-replica-"));
  const host = "mesh-zinlaptop-wsl", machine = "lpt1201-laptop";
  const replica = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
  const { SessionManager } = await import(join(teleport, "node_modules/@earendil-works/pi-coding-agent/dist/index.js"));
  const { coreEnvironment, guardedLaunch, herdrLocation, isHerdrShell, runCore, runHerdr } = await import(join(teleport, "src/herdr.ts"));
  const { appSpaces, runApp } = await import(join(teleport, "src/app.ts"));
  const { readState } = await import(join(teleport, "src/core.ts"));
  const { shellQuote, sshOptions } = await import(join(teleport, "src/remote.ts"));
  const root = join(runRoot, "remote-" + transport), cwd = join(root, "source"), agent = join(root, "agent"), remoteCwd = join(laptopRoot, "destination");
  mkdirSync(cwd, { recursive: true }); mkdirSync(agent);
  const owner = randomUUID(), marker = "APP_REMOTE_FINAL:" + owner;
  const connection = { backend: "app", workspaceId: "", tabId: "", paneId: process.env.HC_TERMINAL_ID!, session: process.env.HC_SESSION!, stateHome: process.env.XDG_STATE_HOME, configHome: process.env.XDG_CONFIG_HOME, runtimeDir: process.env.XDG_RUNTIME_DIR, appHome: process.env.HERDR_APP_HOME, appCli: process.env.PI_INTEGRATION_APP_BIN };
  const settings = (tele: string, rep: string) => ({ extensions: [join(tele, "src/index.ts"), join(rep, "pi-extension/subagents/index.ts"), join(rep, "test/fixtures/app-replica-route-provider.ts")], defaultProvider: "native-replica-route", defaultModel: "route", defaultProjectTrust: "always", quietStartup: true });
  const plan = (actor: string, tele: string) => ({ actor, marker, target: `ssh://${host}${remoteCwd}`, aiEntry: join(tele, "node_modules/@earendil-works/pi-ai/dist/index.js"), teleportHerdr: join(tele, "src/herdr.ts") });
  const preamble = `import * as fs from 'node:fs';import{execFileSync}from'node:child_process';const root=${JSON.stringify(laptopRoot)},agent=root+'/agent';const json=p=>JSON.parse(fs.readFileSync(p,'utf8'));const hc=args=>JSON.parse(execFileSync('hc',args,{encoding:'utf8'}));`;
  const remote = (code: string): any => JSON.parse(execFileSync("ssh", [...sshOptions, host, `node --experimental-strip-types --input-type=module -e ${shellQuote(preamble + code)}`], { encoding: "utf8", timeout: 65_000, stdio: ["ignore", "pipe", "pipe"] }).trim());
  const witness = (side: string) => remote(`const p=agent+'/started-${side}.json';console.log(fs.existsSync(p)?JSON.stringify(json(p)):'null');`);
  const remoteEntries = (file: string) => remote(`console.log(JSON.stringify(fs.readFileSync(${JSON.stringify(file)},'utf8').trim().split('\\n').map(JSON.parse)));`);
  let remoteOwned = false, machineAdded = false, source: any, stateDir: string | undefined, remoteParent: any, child: any;
  const spaces = new Set<string>();
  const controllers = () => readdirSync("/proc").filter(name => /^\d+$/.test(name)).map(Number).filter(pid => {
    try { const args = readFileSync(`/proc/${pid}/cmdline`, "utf8").split("\0"), index = args.indexOf(join(teleport, "src/bridge.ts")); return stateDir && index >= 0 && args[index + 1] === "controller" && args[index + 2]?.startsWith(stateDir + "/bridges/") && readlinkSync(`/proc/${pid}/cwd`) === cwd; } catch { return false; }
  });
  const tunnels = () => readdirSync("/proc").filter(name => /^\d+$/.test(name)).map(Number).filter(pid => {
    try {
      const args = readFileSync(`/proc/${pid}/cmdline`, "utf8").split("\0"), forward = args[args.indexOf("-R") + 1];
      return args.includes("-N") && args.at(-2) === host && forward?.startsWith("/tmp/pi-teleport-") && forward.includes("/return.sock:/tmp/pi-teleport-") && forward.endsWith("/controller.sock") && readlinkSync(`/proc/${pid}/cwd`) === cwd;
    } catch { return false; }
  });
  const capture = async (name: string, terminal: string) => {
    const evidence = process.env.PI_INTEGRATION_APP_EVIDENCE; if (!evidence) return;
    const target = join(evidence, transport); mkdirSync(target, { recursive: true });
    runApp(connection, ["do", "agent.focus", JSON.stringify({ terminal })]);
    let stable = 0;
    await until(() => {
      const world = runApp(connection, ["ls"]), status = runApp(connection, ["status"]);
      const space = world.spaces.find((space: any) => space.tabs.some((tab: any) => tab.terminals.some((pane: any) => pane.terminal === terminal)));
      const tab = space?.tabs.find((tab: any) => tab.terminals.some((pane: any) => pane.terminal === terminal));
      const pane = tab?.terminals.find((pane: any) => pane.terminal === terminal);
      stable = space?.active && tab?.active && status.space === space.id && status.tab === tab.id && status.focused_pane === pane?.pane ? stable + 1 : 0;
      return stable >= 2 ? true : undefined;
    }, "The actual route fixture pane did not become visible.");
    execFileSync(connection.appCli!, ["shot", join(target, name + ".png")], { env: coreEnvironment(connection), timeout: 15_000 });
  };
  try {
    remote(`if(fs.existsSync(${JSON.stringify(runRoot)}))throw Error('The remote shadow namespace is already occupied');if(fs.existsSync(root))throw Error('Do not reuse a remote fixture');for(const name of['destination','agent','state','config'])fs.mkdirSync(root+'/'+name,{recursive:true,mode:0o700});fs.mkdirSync(process.env.XDG_RUNTIME_DIR,{recursive:true,mode:0o700});const status=hc(['server','start']);const current=hc(['server','status']);const fields=fs.readFileSync('/proc/'+current.pid+'/stat','utf8').split(') ').at(-1).split(' ');fs.writeFileSync(root+'/owner.json',JSON.stringify({owner:${JSON.stringify(owner)},pid:current.pid,birth:fields[19]}));console.log('true');`);
    remoteOwned = true;
    const baseline = remote(`fs.writeFileSync(agent+'/settings.json',JSON.stringify(${JSON.stringify(settings(laptopTeleport, laptopReplica))}));fs.writeFileSync(agent+'/route-fixture.json',JSON.stringify(${JSON.stringify(plan("remote", laptopTeleport))}));const cwd=root+'/destination';const git=(...args)=>execFileSync('git',args,{cwd,encoding:'utf8'}).trim();git('init','-b','main');git('config','user.name','Integration');git('config','user.email','integration@example.invalid');fs.writeFileSync(cwd+'/tracked.txt','APP_REMOTE_BASE\\n');git('add','.');git('commit','-m','Create remote fixture');fs.writeFileSync(cwd+'/tracked.txt','APP_REMOTE_DIRTY\\n');fs.writeFileSync(cwd+'/context.txt','APP_REMOTE_UNTRACKED\\n');console.log(JSON.stringify({head:git('rev-parse','HEAD'),index:fs.readFileSync(cwd+'/.git/index').toString('base64')}));`);
    writeFileSync(join(agent, "settings.json"), JSON.stringify(settings(teleport, replica)));
    writeFileSync(join(agent, "route-fixture.json"), JSON.stringify(plan("local", teleport)));
    runCore(connection, ["machine", "add", host, "--name", machine, "--session", process.env.PI_TEST_LAPTOP_SESSION!]); machineAdded = true;
    source = herdrLocation(connection, runHerdr(connection, ["workspace", "create", "--cwd", cwd, "--label", "Route replica source", "--no-focus"])); spaces.add(source.workspaceId);
    await until(() => isHerdrShell(source, source.paneId) ? true : undefined, "The local source shell did not start.");
    const manager = SessionManager.create(cwd, join(agent, "sessions")); manager.appendCustomEntry("route-fixture-seed", { marker });
    const initial = manager.getSessionFile()!; writeFileSync(initial, [manager.getHeader(), ...manager.getEntries()].map(value => JSON.stringify(value)).join("\n") + "\n");
    const cli = join(teleport, "node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js");
    runHerdr(source, ["pane", "run", source.paneId, guardedLaunch([process.execPath, cli, "--approve", "--session", initial, "Carry the route fixture to the laptop and back."], join(root, "source-exit.json"), { PI_CODING_AGENT_DIR: agent, PATH: process.env.PATH! })]);
    const started = await until(() => existsSync(join(agent, "started-source.json")) ? json(join(agent, "started-source.json")) : undefined, "The source Pi did not initialize.");
    stateDir = join(agent, "teleport", started.sessionId); writeFileSync(join(agent, "go-source"), "continue");
    remoteParent = await until(() => witness("remote") ?? undefined, "The remote parent did not initialize.");
    assert.equal(remoteParent.sessionId, started.sessionId); assert.equal(remoteParent.cwd, remoteCwd);
    await until(() => !existsSync(`/proc/${started.pid}`) && !existsSync(initial) ? true : undefined, "The original Pi/session was not retired.");
    assert.equal(appSpaces(connection).flatMap((space: any) => space.tabs.flatMap((tab: any) => tab.terminals)).some((pane: any) => pane.terminal === source.paneId), false);
    if (transport === "ssh") remote(`const info=json(agent+'/started-remote.json'),ctx=json(info.contextFile);fs.copyFileSync(info.contextFile,agent+'/leased-app-context.json');delete ctx.appRoute;ctx.appSsh=${JSON.stringify({ target: "zinpc-benchmark", session: connection.session, stateHome: connection.stateHome, configHome: connection.configHome, runtimeDir: connection.runtimeDir, appHome: connection.appHome, appCli: connection.appCli })};fs.writeFileSync(info.contextFile,JSON.stringify(ctx));console.log('true');`);
    remote(`fs.writeFileSync(agent+'/go-remote','continue');console.log('true');`);
    child = await until(() => witness("child") ?? undefined, "The remote replica did not initialize through its inherited route.");
    assert.notEqual(child.pid, remoteParent.pid); assert.notEqual(child.cwd, remoteCwd);
    assert.equal(child.entry, remoteParent.entry); assert.equal(child.executable, remoteParent.executable); assert.equal(child.contextFile, remoteParent.contextFile);
    assert.notEqual(child.current.pane_id, remoteParent.current.pane_id); assert.notEqual(child.current.workspace_id, remoteParent.current.workspace_id);
    assert.equal(child.context.paneId, child.current.pane_id);
    if (transport === "ssh") { assert.equal(child.context.appRoute, undefined); assert.equal(child.context.appSsh.target, "zinpc-benchmark"); }
    else { assert.equal(typeof child.context.appRoute.socket, "string"); assert.equal(child.context.appSsh, undefined); }
    assert.ok(child.worktrees.some((tree: any) => tree.path === child.cwd && tree.workspaceId === child.current.workspace_id));
    const native = remote(`const info=json(agent+'/started-child.json');console.log(JSON.stringify({cwd:fs.readlinkSync('/proc/'+info.pid+'/cwd'),exe:fs.readlinkSync('/proc/'+info.pid+'/exe'),tracked:fs.readFileSync(info.cwd+'/tracked.txt','utf8'),context:fs.readFileSync(info.cwd+'/context.txt','utf8')}));`);
    assert.equal(native.cwd, child.cwd); assert.equal(native.exe, child.executable); assert.equal(native.tracked, "APP_REMOTE_DIRTY\n"); assert.equal(native.context, "APP_REMOTE_UNTRACKED\n");
    const launch = await until(() => remoteEntries(remoteParent.sessionFile).find((row: any) => row.message?.role === "toolResult" && row.message.toolName === "replicate")?.message, "The remote parent did not receive its launch receipt.");
    assert.notEqual(launch.isError, true); assert.equal(launch.details.id, child.childId);
    runCore(connection, ["send", `${machine}/${remoteParent.current.pane_id}`, "APP_REMOTE_INDEPENDENT"]);
    await until(() => remoteEntries(remoteParent.sessionFile).some((row: any) => row.message?.role === "assistant" && JSON.stringify(row.message.content).includes("APP_REMOTE_INDEPENDENT_DONE")) ? true : undefined, "The remote parent was blocked by its replica.");
    assert.equal(remoteEntries(remoteParent.sessionFile).filter((row: any) => row.customType === "subagent_result").length, 0);
    await capture("parent-active", `${machine}/${remoteParent.current.pane_id}`);
    remote(`fs.writeFileSync(agent+'/release-child','continue');console.log('true');`);
    const result = await until(() => remoteEntries(remoteParent.sessionFile).find((row: any) => row.customType === "subagent_result"), "The remote replica did not deliver.");
    assert.equal(result.details.childId, child.childId); assert.equal(result.details.parentToolCallId, launch.toolCallId); assert.equal(result.details.receiverSessionId, started.sessionId); assert.equal(result.details.exitCode, 0); assert.equal(result.details.integration.status, "applied");
    assert.equal(remoteEntries(result.details.sessionFile)[0].id, child.sessionId);
    await until(() => remote(`const child=json(agent+'/started-child.json'),inventory=hc(['ls','--all']),terminals=Array.isArray(inventory)?inventory:inventory.terminals;console.log(JSON.stringify(!fs.existsSync('/proc/'+child.pid)&&!fs.existsSync(child.cwd)&&!terminals.some(t=>t.address===child.current.pane_id)));`) ? true : undefined, "The remote child checkout or process survived cleanup.");
    const joined = remote(`const cwd=root+'/destination';console.log(JSON.stringify({content:fs.readFileSync(cwd+'/app-result.txt','utf8'),head:execFileSync('git',['rev-parse','HEAD'],{cwd,encoding:'utf8'}).trim(),index:fs.readFileSync(cwd+'/.git/index').toString('base64')}));`);
    assert.equal(joined.content, "APP_REMOTE_JOINED\n"); assert.equal(joined.head, baseline.head); assert.equal(joined.index, baseline.index);
    await capture("parent-result", `${machine}/${remoteParent.current.pane_id}`);
    // Restore the parent's leased control route after testing the replica's SSH route.
    if (transport === "ssh") remote(`const info=json(agent+'/started-remote.json');fs.copyFileSync(agent+'/leased-app-context.json',info.contextFile);console.log('true');`);
    remote(`fs.writeFileSync(agent+'/go-back','continue');console.log('true');`);
    await until(() => existsSync(join(agent, "settled-returned.json")) ? true : undefined, "The parent did not finish back on its original host.");
    const returned = json(join(agent, "started-returned.json")), settled = json(join(agent, "settled-returned.json")), state = readState(stateDir);
    const returnedNative = runHerdr(returned.context, ["pane", "process-info", "--pane", returned.context.paneId]).process_info;
    assert.ok(returnedNative.foreground_processes.some((process: any) => process.pid === returned.pid && process.cwd === cwd));
    assert.notEqual(returned.pid, started.pid);
    spaces.add(returned.context.workspaceId); assert.equal(returned.sessionId, started.sessionId); assert.equal(returned.cwd, cwd); assert.equal(returned.entry, started.entry);
    assert.equal(state.history.length, 2); assert.deepEqual(state.history.map((move: any) => move.status), ["completed", "completed"]);
    assert.equal(settled.entries.filter((row: any) => row.customType === "subagent_result").length, 1);
    assert.equal(settled.entries.filter((row: any) => row.customType === "pi-agent-teleport-continuation").length, 2);
    const receipts = settled.entries.filter((row: any) => row.message?.role === "toolResult" && row.message.toolName === "teleport").map((row: any) => row.message);
    assert.deepEqual(receipts.map((receipt: any) => receipt.details.action), ["jump", "back"]);
    for (const receipt of receipts) { assert.equal(receipt.isError, false); assert.equal(receipt.details.execution.sessionId, started.sessionId); assert.equal(receipt.details.execution.toolCallId, receipt.toolCallId); }
    assert.equal(settled.entries.filter((row: any) => row.message?.role === "assistant" && row.message.content.some((part: any) => part.type === "text" && part.text === marker)).length, 1);
    await until(() => controllers().length === 0 ? true : undefined, "The authenticated route controller did not exit.");
    await capture("parent-returned", returned.current.pane_id);
    console.log(JSON.stringify({ routeVerified: transport, sessionId: started.sessionId, sourcePid: started.pid, remotePid: remoteParent.pid, childPid: child.pid, returnedPid: returned.pid }));
  } finally {
    const forwards = tunnels().map(pid => { const args = readFileSync(`/proc/${pid}/cmdline`, "utf8").split("\0"); return args[args.indexOf("-R") + 1].split(":"); });
    const evidence = process.env.PI_INTEGRATION_APP_EVIDENCE;
    if (evidence) {
      const target = join(evidence, transport); mkdirSync(target, { recursive: true });
      for (const name of ["started-source.json", "started-returned.json", "settled-returned.json"]) if (existsSync(join(agent, name))) writeFileSync(join(target, name), readFileSync(join(agent, name)));
      if (remoteOwned) { try { writeFileSync(join(target, "remote-evidence.json"), JSON.stringify(remote(`const names=['started-remote.json','started-child.json','settled-remote.json','settled-child.json'];const saved=Object.fromEntries(names.filter(n=>fs.existsSync(agent+'/'+n)).map(n=>[n,json(agent+'/'+n)]));const own=json(root+'/owner.json');if(fs.existsSync('/proc/'+own.pid)){const all=hc(['ls','--all']);saved.terminals=(Array.isArray(all)?all:all.terminals).map(t=>({record:hc(['get',t.address]),screen:execFileSync('hc',['read',t.address,'--lines','80'],{encoding:'utf8'})}));}console.log(JSON.stringify(saved));`))); } catch (error) { writeFileSync(join(target, "remote-evidence-error.txt"), String(error)); } }
    }
    if (remoteOwned) remote(`fs.writeFileSync(agent+'/release-child','cleanup');console.log('true');`);
    if (stateDir) { const state = readState(stateDir); if (state.active?.herdr && !state.active.herdr.appMachine) spaces.add(state.active.herdr.workspaceId); }
    for (const space of appSpaces(connection)) if (spaces.has(space.id) || space.machine === machine) runApp(connection, ["do", "space.close", JSON.stringify({ id: space.id, confirmed: true })]);
    if (machineAdded) runCore(connection, ["machine", "rm", machine]);
    for (const pid of controllers()) process.kill(pid, "SIGTERM");
    await until(() => controllers().length === 0 ? true : undefined, "An owned route controller survived teardown.");
    for (const pid of tunnels()) process.kill(pid, "SIGTERM");
    await until(() => tunnels().length === 0 ? true : undefined, "An owned SSH forwarding process survived teardown.");
    for (const [remoteSocket, localSocket] of forwards) {
      if (existsSync(localSocket)) { assert.ok(lstatSync(localSocket).isSocket()); unlinkSync(localSocket); }
      try { rmdirSync(dirname(localSocket)); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
      remote(`const socket=${JSON.stringify(remoteSocket)};if(fs.existsSync(socket)){if(!fs.lstatSync(socket).isSocket())throw Error('Unexpected callback resource');fs.unlinkSync(socket)}try{fs.rmdirSync(socket.slice(0,socket.lastIndexOf('/')))}catch(e){if(e.code!=='ENOENT')throw e}console.log('true');`);
    }
    if (remoteOwned) remote(`const own=json(root+'/owner.json');if(own.owner!==${JSON.stringify(owner)})throw Error('Remote fixture ownership changed');const birth=pid=>{try{return fs.readFileSync('/proc/'+pid+'/stat','utf8').split(') ').at(-1).split(' ')[19]}catch(e){if(e.code==='ENOENT')return;throw e}};const pids=[];if(birth(own.pid)===own.birth){const value=hc(['ls','--all']);for(const item of(Array.isArray(value)?value:value.terminals)){const t=hc(['get',item.address]);if(t.pid)pids.push({pid:t.pid,birth:birth(t.pid)});if(t.state==='live')hc(['kill',t.address]);hc(['rm',t.address])}hc(['server','stop'])}else if(birth(own.pid))throw Error('Remote core identity changed');const end=Date.now()+20000;for(;;){const users=fs.readdirSync('/proc').filter(n=>/^\\d+$/.test(n)).filter(n=>{try{const cwd=fs.readlinkSync('/proc/'+n+'/cwd');return cwd===root||cwd.startsWith(root+'/')}catch(e){if(['ENOENT','ESRCH','EACCES','EPERM'].includes(e.code))return false;throw e}});if(birth(own.pid)!==own.birth&&pids.every(p=>birth(p.pid)!==p.birth)&&users.length===0)break;if(Date.now()>end)throw Error('Owned remote processes survived cleanup');await new Promise(r=>setTimeout(r,50))}fs.rmSync(root,{recursive:true});fs.rmSync(${JSON.stringify(runRoot)},{recursive:true,force:true});fs.rmSync(process.env.XDG_RUNTIME_DIR,{recursive:true,force:true});console.log('true');`);
  }
});
