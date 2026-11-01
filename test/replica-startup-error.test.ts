import assert from "node:assert/strict";
import { it } from "node:test";
import { waitForCompletion, type CompletionOptions } from "../pi-extension/subagents/completion.ts";

it("keeps the module-load diagnostic when a replica exits without child completion", { timeout: 2000 }, async () => {
	const options: CompletionOptions & { readFailureOutput: () => Promise<string> } = {
		intervalMs: 1,
		readTerminalTail: async () => "__SUBAGENT_DONE_1__\nroot@host:#",
		readFailureOutput: async () => "root@host:# bash launch.sh\nError: Failed to load extension: Cannot find module 'startup-module'\nRequire stack:\n- /copy/resource-host.ts\nWarning: harmless package warning\nHint: pi -ne\n__SUBAGENT_DONE_1__\nroot@host:#",
	};
	const result = await waitForCompletion(new AbortController().signal, options);
	assert.equal(result.reason, "sentinel");
	assert.equal(result.exitCode, 1);
	assert.match(result.errorMessage ?? "", /Cannot find module 'startup-module'/);
	assert.match(result.errorMessage ?? "", /resource-host\.ts/);
	assert.doesNotMatch(result.errorMessage ?? "", /Warning:|Hint:|SUBAGENT_DONE|root@host/);
});

it("does not invent a startup cause when diagnostic output cannot be read", { timeout: 2000 }, async () => {
	const options: CompletionOptions & { readFailureOutput: () => Promise<string> } = {
		intervalMs: 1, readTerminalTail: async () => "__SUBAGENT_DONE_7__",
		readFailureOutput: async () => { throw new Error("pane unavailable"); },
	};
	const result = await waitForCompletion(new AbortController().signal, options);
	assert.equal(result.reason, "sentinel");
	assert.equal(result.exitCode, 7);
	assert.equal(result.errorMessage, undefined);
});

it("leaves retained-launch sentinel recovery facts unchanged without the replica diagnostic option", { timeout: 2000 }, async () => {
	const result = await waitForCompletion(new AbortController().signal, {
		intervalMs: 1, readTerminalTail: async () => "Error: original error\n__SUBAGENT_DONE_7__",
	});
	assert.deepEqual(result, { reason: "sentinel", exitCode: 7 });
});

it("does not turn warning output into a completed or failed process", { timeout: 2000 }, async () => {
	const abort = new AbortController(); let diagnosticReads = 0;
	const timer = setTimeout(() => abort.abort(), 25);
	const options: CompletionOptions & { readFailureOutput: () => Promise<string> } = {
		intervalMs: 2, readTerminalTail: async () => "Warning: an extension printed a warning",
		readFailureOutput: async () => { diagnosticReads++; return "Warning: not a process exit"; },
	};
	try { await assert.rejects(waitForCompletion(abort.signal, options), /Aborted/); }
	finally { clearTimeout(timer); }
	assert.equal(diagnosticReads, 0);
});

it("discards a stale terminal marker when a replacement process is active", { timeout: 2000 }, async () => {
	const abort = new AbortController(); let diagnostics = 0;
	const timer = setTimeout(() => abort.abort(), 25);
	try {
		await assert.rejects(waitForCompletion(abort.signal, {
			intervalMs: 2, readTerminalTail: async () => "__SUBAGENT_DONE_1__",
			confirmTerminalExit: () => false,
			readFailureOutput: async () => { diagnostics++; return "Error: old process error"; },
		}), /Aborted/);
	} finally { clearTimeout(timer); }
	assert.equal(diagnostics, 0);
});

it("revalidates process exit after reading its diagnostic", { timeout: 2000 }, async () => {
	const abort = new AbortController(); let checks = 0;
	const timer = setTimeout(() => abort.abort(), 25);
	try {
		await assert.rejects(waitForCompletion(abort.signal, {
			intervalMs: 2, readTerminalTail: async () => "__SUBAGENT_DONE_1__",
			confirmTerminalExit: () => ++checks === 1,
			readFailureOutput: async () => "Error: superseded process",
		}), /Aborted/);
	} finally { clearTimeout(timer); }
	assert.ok(checks >= 2);
});
