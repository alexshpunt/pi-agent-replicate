import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { currentAppPane } from "../../pi-extension/subagents/herdr-app.ts";
import { listHerdrWorktrees } from "../../pi-extension/subagents/herdr.ts";

/** Only inference is scripted. Both hosts use real Pi, App, core, Git and SSH. */
export default async function routeProvider(pi: any) {
  const root = process.env.PI_CODING_AGENT_DIR!;
  const plan = JSON.parse(readFileSync(join(root, "route-fixture.json"), "utf8"));
  const preflight = Boolean(process.env.PI_TELEPORT_PREFLIGHT || process.env.PI_TELEPORT_PROBE);
  const side = process.env.PI_SUBAGENT_REPLICATION === "1" ? "child" : plan.actor === "remote" ? "remote" : existsSync(join(root, "started-source.json")) ? "returned" : "source";
  const { createAssistantMessageEventStream } = await import(plan.aiEntry);
  const { getHerdrContext } = await import(plan.teleportHerdr);
  pi.on("session_start", (_event: unknown, ctx: any) => {
    if (preflight) return;
    writeFileSync(join(root, `started-${side}.json`), JSON.stringify({
      pid: process.pid, cwd: process.cwd(), executable: process.execPath, entry: process.argv[1],
      sessionId: ctx.sessionManager.getSessionId(), sessionFile: ctx.sessionManager.getSessionFile(),
      childId: process.env.PI_SUBAGENT_ID, contextFile: process.env.PI_TELEPORT_APP_CONTEXT,
      appCli: process.env.PI_HERDR_APP_CLI, context: getHerdrContext(), current: currentAppPane(),
      ...(side === "child" ? { worktrees: listHerdrWorktrees(process.cwd()) } : {}),
    }));
  });
  pi.on("agent_settled", (_event: unknown, ctx: any) => {
    if (preflight) return;
    writeFileSync(join(root, `settled-${side}.json`), JSON.stringify({
      pid: process.pid, header: ctx.sessionManager.getHeader(), entries: ctx.sessionManager.getEntries(),
    }));
  });
  const gate = async (name: string) => {
    const end = Date.now() + 120_000;
    while (!existsSync(join(root, name))) {
      if (Date.now() > end) throw new Error("The route fixture gate was not released: " + name);
      await new Promise(resolve => setTimeout(resolve, 25));
    }
  };
  pi.registerProvider("native-replica-route", {
    name: "Native route fixture", baseUrl: "http://native-route.invalid", apiKey: "local", api: "openai-completions",
    models: [{ id: "route", name: "Native route fixture", reasoning: false, input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 128000, maxTokens: 4096 }],
    streamSimple: (model: any, context: any) => {
      if (preflight) throw new Error("Preflight must not request inference.");
      const stream = createAssistantMessageEventStream();
      const messages: any[] = context.messages ?? [];
      const calls = messages.flatMap(message => Array.isArray(message.content) ? message.content.filter((part: any) => part.type === "toolCall") : []);
      const has = (name: string) => calls.some(call => call.name === name);
      const content = (value: any) => typeof value === "string" ? value : Array.isArray(value) ? value.map(part => part.text ?? "").join("\n") : "";
      const latestUser = content([...messages].reverse().find(message => message.role === "user")?.content);
      const tool = (id: string, name: string, args: object) => ({ type: "toolCall", id, name, arguments: args });
      let body: any[], wait: string | undefined;
      if (side === "source") {
        body = [tool("route-source-jump", "teleport", { action: "jump", target: plan.target })]; wait = "go-source";
      } else if (side === "returned") body = [{ type: "text", text: plan.marker }];
      else if (side === "child") {
        if (!has("read")) body = [tool("route-child-read-tracked", "read", { path: "tracked.txt" }), tool("route-child-read-context", "read", { path: "context.txt" })];
        else if (!has("write")) body = [tool("route-child-write", "write", { path: "app-result.txt", content: "APP_REMOTE_JOINED\n" })];
        else { body = [{ type: "text", text: "APP_REMOTE_CHILD_SUMMARY" }]; wait = "release-child"; }
      } else if (messages.some(message => content(message.content).includes("APP_REMOTE_CHILD_SUMMARY"))) {
        body = [tool("route-remote-back", "teleport", { action: "back" })]; wait = "go-back";
      } else if (latestUser.includes("APP_REMOTE_INDEPENDENT")) body = [{ type: "text", text: "APP_REMOTE_INDEPENDENT_DONE" }];
      else if (!has("replicate")) {
        body = [tool("route-remote-replicate", "replicate", { name: "remote-write-result", task: "APP_REMOTE_CHILD. Read tracked.txt and context.txt, then write app-result.txt." })]; wait = "go-remote";
      } else body = [{ type: "text", text: "APP_REMOTE_PARENT_ACK" }];
      const toolUse = body.some(part => part.type === "toolCall");
      const message = { role: "assistant", content: body, api: model.api, provider: model.provider, model: model.id,
        stopReason: toolUse ? "toolUse" : "stop", timestamp: Date.now(), usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
      queueMicrotask(async () => {
        try { if (wait) await gate(wait); stream.push({ type: "start", partial: message }); stream.push({ type: "done", reason: message.stopReason, message }); stream.end(); }
        catch (error) { stream.push({ type: "error", reason: "error", error: { ...message, stopReason: "error", errorMessage: String(error) } }); stream.end(); }
      });
      return stream;
    },
  });
}
