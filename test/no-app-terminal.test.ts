import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const setup = "./test/no-app-terminal.ts";

test("npm test loads the setup that removes the Herdr App terminal environment", () => {
	const pkg = JSON.parse(readFileSync("package.json", "utf8")) as { scripts: Record<string, string> };
	assert.match(pkg.scripts.test, /--import \.\/test\/no-app-terminal\.ts --test /);
});

test("the setup removes App terminal variables and App routing settings and keeps the rest", () => {
	const app = {
		HC_TERMINAL_ID: "t7", HC_TERMINAL_SOCKET: "/tmp/core", HC_SOCKET: "/tmp/core", HC_SCOPE: "scope", HC_SESSION: "private",
		PI_TELEPORT_APP_CONTEXT: "/tmp/route.json", PI_HERDR_APP_CLI: "/pi/app", PI_HERDR_APP_MACHINE: "laptop",
		HERDR_APP_BIN: "/bin/app", HERDR_APP_HOME: "/app",
	};
	const output = execFileSync(process.execPath, ["--experimental-strip-types", "--import", setup, "-e", "process.stdout.write(JSON.stringify(process.env))"], {
		env: { ...process.env, ...app, HERDR_ENV: "1", PI_NO_APP_TERMINAL_KEEP: "kept" },
		encoding: "utf8",
	});
	const env = JSON.parse(output) as Record<string, string>;
	for (const key of Object.keys(app)) assert.equal(env[key], undefined, key);
	assert.equal(env.HERDR_ENV, "1");
	assert.equal(env.PI_NO_APP_TERMINAL_KEEP, "kept");
});
