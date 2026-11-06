import assert from "node:assert/strict";
import { test } from "node:test";
import { isTerminalAvailable } from "../../pi-extension/subagents/terminal.ts";

test("Replicate recognizes its verified native App terminal", () => {
  assert.equal(process.env.PI_INTEGRATION_BACKEND, "app");
  assert.ok(process.env.HC_TERMINAL_ID);
  assert.equal(isTerminalAvailable(), true);
});
