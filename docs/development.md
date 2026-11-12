# Development

```bash
npm test
npm run lint
npm pack --dry-run
npm run typecheck
node --check index.js
git diff --check
```

`npm test` loads `test/no-app-terminal.ts` first. It removes the Herdr App terminal variables (`HC_*`) and the App routing settings from the environment, so the unit tests give the same results in a Herdr App terminal as anywhere else. A test of App behavior sets the App environment it needs itself.

`npm run typecheck` runs `tsc -p tsconfig.json`. The config covers `index.ts`, `pi-extension` and `test`, loads the Node types and checks in strict mode, so editors use it for `test/` too. Install the pinned TypeScript with `npm ci` first. Don't run `tsc index.ts`: it ignores the config and fails on `.ts` import paths.

The isolated runner tests the Pi that `devDependencies` pin, from `node_modules/.bin`, whether you call it through npm or directly. It prints that version as `piVersion` and stops if `pi --version` does not match the pinned version, which happens when `node_modules` is stale. To test another Pi version, change the three `@earendil-works/pi-*` devDependencies and the tested version in `README.md`, then run `npm install`.

Run selected isolated real-Pi and Herdr cases from inside Herdr:

```bash
npm run test:integration -- test/integration/replication.test.ts
```

For a manual TUI check with a deterministic provider, set `PI_INTEGRATION_TUI_DIR` to a fresh ignored directory and `PI_INTEGRATION_IDE_ENTRY` to the current IDE source entry. Run only this case:

```bash
node --experimental-strip-types test/integration/run-isolated.ts \
  --test-name-pattern='renders an active isolated replica' test/integration/replication.test.ts
```

The case reloads Pi and records the loaded IDE in `runtime.json`. The applied and failed cases each write to their own subdirectory. Use its `pane.json` to attach a read-only observer to the private Herdr endpoint. Capture the active pane, then create `release-child` in the inspection directory. Capture the delivered result, then create `finish` so the runner can clean up. Both observation gates time out after five minutes. Do not use the user's persistent Herdr server.

See [RELEASING.md](../RELEASING.md) for release checks.
