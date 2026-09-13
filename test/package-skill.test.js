import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const packageFiles = new Set(JSON.parse(execFileSync("npm", ["pack", "--dry-run", "--json"], { cwd: root, encoding: "utf8" }))[0].files.map(({ path }) => path));

describe("minimal production package", () => {
  it("ships the extension and public API without workflows, skills, or built-in roles", () => {
    assert.deepEqual(manifest.pi?.extensions, ["./pi-extension/subagents/index.ts"]);
    assert.equal(manifest.pi?.skills, undefined);
    for (const path of ["README.md", "AGENTS.md", "CONTEXT.md", "RELEASING.md", "index.js", "index.d.ts", "pi-extension/subagents/index.ts"]) {
      assert.equal(packageFiles.has(path), true, `missing package file: ${path}`);
    }
    for (const path of packageFiles) {
      assert.doesNotMatch(path, /(^|\/)(?:skills|agents\/built-in)(?:\/|$)/);
      assert.doesNotMatch(path, /(?:workflow-worker\.js|plan-skill\.md|model-config\.(?:js|ts))$/);
      assert.doesNotMatch(path, /(^|\/)(?:\.pi|test|prototypes?|sessions|\.reviews|\.tmp)(?:\/|$)|(^|\/)(?:run\.jsonl|config\.json)$/);
    }
  });
});
