// Isolated helper for synchronous callers of Teleport's authenticated App channel.
import { readFileSync } from "node:fs";
import { createConnection } from "node:net";

const limit = 16 * 1024 * 1024;
try {
  const input = readFileSync(0, "utf8");
  if (Buffer.byteLength(input) > limit) throw new Error("App request exceeds its limit.");
  const { route, args } = JSON.parse(input);
  const message = JSON.stringify({ action: "app", args, token: route.token }) + "\n";
  const tcp = /^tcp:\/\/127\.0\.0\.1:([1-9]\d{0,4})$/.exec(route.socket);
  if (route.socket.startsWith("tcp://") && (!tcp || Number(tcp[1]) > 65535)) throw new Error("Invalid App loopback channel.");
  const socket = tcp ? createConnection({ host: "127.0.0.1", port: Number(tcp[1]) }) : createConnection(route.socket);
  let content = "", submitted = false, finished = false;
  const finish = (reply: unknown) => {
    if (finished) return;
    finished = true;
    socket.destroy();
    process.stdout.write(JSON.stringify(reply));
  };
  socket.setTimeout(35_000, () => finish({ ok: false, uncertain: submitted, error: "App controller timed out." }));
  socket.setEncoding("utf8");
  socket.on("connect", () => { submitted = true; socket.write(message); });
  socket.on("data", (chunk: string) => {
    content += chunk;
    if (Buffer.byteLength(content) > limit) return finish({ ok: false, uncertain: true, error: "App response exceeds its limit." });
    const end = content.indexOf("\n");
    if (end < 0) return;
    try { finish(JSON.parse(content.slice(0, end))); }
    catch { finish({ ok: false, uncertain: true, error: "App response is malformed." }); }
  });
  socket.on("error", (error) => finish({ ok: false, uncertain: submitted, error: error.message }));
  socket.on("end", () => finish({ ok: false, uncertain: submitted, error: "App controller closed without a receipt." }));
} catch (error) {
  process.stdout.write(JSON.stringify({ ok: false, error: String(error) }));
}
