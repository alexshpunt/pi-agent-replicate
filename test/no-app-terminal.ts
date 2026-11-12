/**
 * Loaded by `npm test` through `--import` before every test file.
 *
 * A Herdr App terminal gives its processes `HC_*` variables, and the extension
 * switches to the App backend when it sees `HC_TERMINAL_ID`. Inherited, they
 * make Herdr tests call the real `hc` and fail in an App terminal while they
 * pass elsewhere. Removing the App terminal environment and the App routing
 * settings here gives the same results in any terminal. Tests of App behavior
 * set the App environment they need themselves.
 */
for (const key of Object.keys(process.env)) {
	if (key.startsWith("HC_")) delete process.env[key];
}
for (const key of ["PI_TELEPORT_APP_CONTEXT", "PI_HERDR_APP_CLI", "PI_HERDR_APP_MACHINE", "HERDR_APP_BIN", "HERDR_APP_HOME"]) {
	delete process.env[key];
}
