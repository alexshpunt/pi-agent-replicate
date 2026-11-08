import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createAppTab, appSpaces } from "../pi-extension/subagents/app-operations.ts";
import { parkAppTerminal } from "../pi-extension/subagents/app-operations.ts";

test("creates a tab on the owning machine and returns only native handles", { skip: process.platform === "win32" }, () => {
  const dir = mkdtempSync(join(tmpdir(), "replicate-app-create-"));
  try {
    const cli = join(dir, "app"), record = join(dir, "request");
    writeFileSync(cli, `#!/bin/sh\nprintf '%s' "$3" > '${record}'\nprintf '%s\n' '{"space":"desk/s1","tab":"desk/b2","terminal":"desk/t3"}'\n`);
    chmodSync(cli, 0o755);
    const context = { paneId: "t7", tabId: "b1", workspaceId: "s1", session: "owned", appMachine: "desk", appCli: cli };
    assert.deepEqual(createAppTab(context, "s1", "/checkout", "replica"), { workspaceId: "s1", tabId: "b2", paneId: "t3" });
    assert.deepEqual(JSON.parse(readFileSync(record, "utf8")), { space: "desk/s1", folder: "/checkout", name: "replica", focus: false });
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("filters App spaces to the owning machine and rejects mismatched handles", { skip: process.platform === "win32" }, () => {
  const dir = mkdtempSync(join(tmpdir(), "replicate-app-spaces-"));
  try {
    const cli = join(dir, "app");
    const payload = { spaces: [{ machine: "other", id: "other/s1", tabs: [] }, { machine: "desk", id: "desk/s1", tabs: [{ id: "desk/b1", terminals: [{ terminal: "other/t1", pane: "desk/p1" }] }] }] };
    writeFileSync(cli, `#!/bin/sh\nprintf '%s\\n' '${JSON.stringify(payload)}'\n`); chmodSync(cli, 0o755);
    const context = { paneId: "t7", tabId: "b1", workspaceId: "s1", session: "owned", appMachine: "desk", appCli: cli };
    assert.throws(() => appSpaces(context));
    payload.spaces[1].tabs[0].terminals[0].terminal = "desk/t1";
    writeFileSync(cli, `#!/bin/sh\nprintf '%s\\n' '${JSON.stringify(payload)}'\n`);
    assert.deepEqual(appSpaces(context), [{ id: "s1", tabs: [{ id: "b1", terminals: [{ terminal: "t1", pane: "p1" }] }] }]);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});


test("does not change the user's focus when an App version lacks background creation", { skip: process.platform === "win32" }, () => {
  const dir = mkdtempSync(join(tmpdir(), "replicate-app-focus-"));
  try {
    const cli = join(dir, "app"), record = join(dir, "requests");
    writeFileSync(cli, `#!/bin/sh\nprintf '%s\\n' "$3" >> '${record}'\ncase "$3" in *focus*) printf '%s\\n' '{"error":"tab.new: unknown argument(s): focus; valid arguments: space"}'; exit 1;; esac\nprintf '%s\\n' '{"space":"s1","tab":"b2","terminal":"t3"}'\n`); chmodSync(cli, 0o755);
    const context = { paneId: "t7", tabId: "b1", workspaceId: "s1", session: "owned", appCli: cli };
    assert.throws(() => createAppTab(context, "s1", "/checkout", "replica"));
    assert.equal(readFileSync(record, "utf8").trim().split("\n").length, 1);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});


test("parks only the owned terminal and confirms its pane disappeared", { skip: process.platform === "win32" }, () => {
  const dir = mkdtempSync(join(tmpdir(), "replicate-app-park-"));
  try {
    const cli = join(dir, "app"), calls = join(dir, "calls");
    writeFileSync(cli, `#!/bin/sh\nprintf '%s %s %s\\n' "$1" "$2" "$3" >> '${calls}'\nif [ "$2" = terminal.park ]; then printf '%s\\n' '{"pending":true,"terminal":"desk/t3"}'; else printf '%s\\n' '{"spaces":[{"machine":"desk","id":"desk/s1","tabs":[{"id":"desk/b1","terminals":[]}]}]}'; fi\n`); chmodSync(cli, 0o755);
    const context = { paneId: "t7", tabId: "b1", workspaceId: "s1", session: "owned", appMachine: "desk", appCli: cli };
    parkAppTerminal(context, "t3");
    const lines = readFileSync(calls, "utf8").trim().split("\n");
    assert.deepEqual(lines, ['do terminal.park {"terminal":"desk/t3"}', "ls  ".trimEnd()]);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});