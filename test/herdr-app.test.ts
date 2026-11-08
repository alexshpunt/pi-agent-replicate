import { strict as assert } from "node:assert";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";

// A private fake core: this test never touches the user's Herdr server.
test("recognizes an owned Herdr App terminal without the legacy Herdr environment", { skip: process.platform === "win32" }, () => {
  const dir = mkdtempSync(join(tmpdir(), "replicate-app-test-"));
  try {
    const hc = join(dir, "hc");
    writeFileSync(hc, `#!/bin/sh\n[ "$1" = get ] && [ "$2" = t7 ] && printf '%s\\n' '{"address":"t7","state":"live","labels":{"herdr.space":"space","herdr.tab":"tab"}}'\n`);
    chmodSync(hc, 0o755);
    const module = resolve("pi-extension/subagents/herdr.ts");
    const code = `import {isHerdrAvailable} from ${JSON.stringify(module)}; console.log(JSON.stringify(isHerdrAvailable()));`;
    const env = { ...process.env, HC_TERMINAL_ID: "t7", PATH: `${dir}:${process.env.PATH}` };
    delete env.HERDR_ENV;
    delete env.PI_TELEPORT_APP_CONTEXT;
    delete env.HC_SOCKET;
    delete env.HC_TERMINAL_SOCKET;
    delete env.HC_SCOPE;
    assert.equal(JSON.parse(execFileSync(process.execPath, ["--experimental-strip-types", "--input-type=module", "-e", code], { env, encoding: "utf8" })), true);
    env.HC_TERMINAL_ID = "not-an-app-terminal";
    assert.equal(JSON.parse(execFileSync(process.execPath, ["--experimental-strip-types", "--input-type=module", "-e", code], { env, encoding: "utf8" })), false);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
