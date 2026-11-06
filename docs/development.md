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

### Two-host App route cases

Run `test/integration/app-remote-replica.test.ts` as a separate explicit file through the same isolated runner. It moves a real Pi from the desktop to the laptop, launches a replica through either the inherited controller or explicit App SSH route, checks an independent parent turn and one applied result, then returns the parent to the desktop. It also checks native process identities, source HEAD/index preservation and owned-resource cleanup. The provider replaces inference only; Pi, App, Core, Git and SSH are real.

This fixture requires existing Teleport checkouts with their SDK dependencies on both hosts, trusted `mesh-zinlaptop-wsl` and `zinpc-benchmark` SSH aliases, and a task-owned SSH wrapper that supplies the laptop's private Core session and XDG paths. Set `PI_INTEGRATION_TELEPORT_SOURCE`, `PI_TEST_LAPTOP_SOURCE`, `PI_TEST_LAPTOP_TOOLS`, `PI_INTEGRATION_LAPTOP_REPLICA_SOURCE`, `PI_TEST_LAPTOP_ROOT` and `PI_TEST_LAPTOP_SESSION`. The remote root must be new, outside persistent user state. Do not point the wrapper at the user's Core. `PI_INTEGRATION_APP_EVIDENCE` saves the selected parent while its replica runs, after delivery and after the return.

The SSH override is temporary: after the replica settles, the fixture restores the parent's original controller route so Teleport can retire its lease. These cases settle the replica before moving its parent again. They do not establish portable cross-host lineage or concurrent parent moves.

The project-only fixture type check uses `--skipLibCheck` with the locked SDK's existing declaration incompatibilities. Report dependency declaration errors separately from errors in project code.

## Manual TUI inspection

For a manual TUI check with a deterministic provider, set `PI_INTEGRATION_TUI_DIR` to a fresh ignored directory and `PI_INTEGRATION_IDE_ENTRY` to the current IDE source entry. Run only this case with the intended Pi binary on `PATH`:

```bash
node --experimental-strip-types test/integration/run-isolated.ts \
  --test-name-pattern='renders an active isolated replica' test/integration/replication.test.ts
```

The case reloads Pi and records the loaded IDE in `runtime.json`. The applied and failed cases each write to their own subdirectory. Use its `pane.json` to attach a read-only observer to the private Herdr endpoint. Capture the active pane, then create `release-child` in the inspection directory. Capture the delivered result, then create `finish` so the runner can clean up. Both observation gates time out after five minutes. Do not use the user's persistent Herdr server.

See [RELEASING.md](../RELEASING.md) for release checks.
