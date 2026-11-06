# Development

```bash
npm test
npm run lint
npm pack --dry-run
npx tsc --noEmit index.ts
node --check index.js
git diff --check
```

Run selected isolated real-Pi and Herdr cases from inside Herdr:

```bash
npm run test:integration -- test/integration/replication.test.ts
```

## Native Herdr App

On Linux, provide an existing App executable and the actual Pi Node entry point. A profile wrapper that changes `PI_CODING_AGENT_DIR` breaks the private test configuration. Use a task-owned display when running headlessly.

```bash
PI_INTEGRATION_BACKEND=app \
PI_INTEGRATION_APP_BIN=/absolute/path/to/herdr-app \
PI_INTEGRATION_PI_ENTRY=/absolute/path/to/pi-cli.js \
node --experimental-strip-types test/integration/run-isolated.ts \
  test/integration/app-replica.test.ts \
  test/integration/app-terminal.test.ts \
  test/integration/app-public-tree.test.ts
```

Pass an explicit file list. The native runner starts its own App window and core with a fresh home, configuration and repositories. It denies the persistent legacy socket, verifies process birth identities and checks for surviving checkout users before deleting its paths. It acknowledges onboarding only in that private home; it never edits UI layout. `PI_INTEGRATION_APP_EVIDENCE` optionally saves transcripts and screenshots outside the disposable root.

The native cases cover dirty snapshots, one-result delivery and reload, failed and conflicting work retention, shared directories, terminal ownership and Escape. Installed-package cases exercise both the model tool and the package-root API. Native Windows/macOS process ownership is unsupported; Linux results do not verify those platforms.

The project-only fixture type check uses `--skipLibCheck` with the locked SDK's existing declaration incompatibilities. Report dependency declaration errors separately from errors in project code.

## Manual TUI inspection

For a manual TUI check with a deterministic provider, set `PI_INTEGRATION_TUI_DIR` to a fresh ignored directory and `PI_INTEGRATION_IDE_ENTRY` to the current IDE source entry. Run only this case with the intended Pi binary on `PATH`:

```bash
node --experimental-strip-types test/integration/run-isolated.ts \
  --test-name-pattern='renders an active isolated replica' test/integration/replication.test.ts
```

The case reloads Pi and records the loaded IDE in `runtime.json`. The applied and failed cases each write to their own subdirectory. Use its `pane.json` to attach a read-only observer to the private Herdr endpoint. Capture the active pane, then create `release-child` in the inspection directory. Capture the delivered result, then create `finish` so the runner can clean up. Both observation gates time out after five minutes. Do not use the user's persistent Herdr server.

See [RELEASING.md](../RELEASING.md) for release checks.
