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

For a manual TUI check with a deterministic provider, set `PI_INTEGRATION_TUI_DIR` to a fresh ignored directory and `PI_INTEGRATION_IDE_ENTRY` to the current IDE source entry. Run only this case with the intended Pi binary on `PATH`:

```bash
node --experimental-strip-types test/integration/run-isolated.ts \
  --test-name-pattern='renders an active isolated replica' test/integration/replication.test.ts
```

The case reloads Pi and records the loaded IDE in `runtime.json`. The applied and failed cases each write to their own subdirectory. Use its `pane.json` to attach a read-only observer to the private Herdr endpoint. Capture the active pane, then create `release-child` in the inspection directory. Capture the delivered result, then create `finish` so the runner can clean up. Both observation gates time out after five minutes. Do not use the user's persistent Herdr server.

See [RELEASING.md](../RELEASING.md) for release checks.
