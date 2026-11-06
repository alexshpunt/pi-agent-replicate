---
name: run-integration-tests
description: Run the integration test suite and verify all sessions end-to-end. Use when asked to run integration or e2e tests, test before release, or check everything works.
---

# Run integration tests

Use the installed Herdr CLI or native Herdr App backend. The caller does not need an existing Herdr session: the isolated runner starts its own backend. Read [development instructions](../../../docs/development.md) for commands and native fixture prerequisites.

## Preflight

Run `npm test` and `npm pack --dry-run`. Check that the selected backend executable exists. Native App cases require Linux, an App executable, an actual Pi Node entry point and an available display. Do not substitute a profile wrapper that overwrites the fixture's agent directory. An unavailable platform or backend is a verification gap; do not report it as passing.

## Integration suite

Run lifecycle and terminal cases only through `test/integration/run-isolated.ts`, with an explicit test file list. Select native App with `PI_INTEGRATION_BACKEND=app` and the executable variables documented in development instructions. Do not set `HERDR_ENV=1` to imitate native App or point tests at the persistent user server.

The legacy runner owns a private headless server and socket. The native runner owns a separate App window, core, home and repositories, with the legacy user socket denied. Both runners confirm owned process termination before removing their paths, including on failure and signals.

Use the deterministic provider for lifecycle checks. It scripts inference while Pi, terminal processes and Git remain real. A live-provider smoke test is optional and requires the paid-model-runs workflow. Never replace real terminal or process behavior with fabricated backend responses.

Wait for observable journal, pane, process, file or screen conditions. For App screenshots, wait for the actual selected space, tab and pane. `status.agent` can name an invisible fallback agent. Inspect the saved images before treating them as visual proof.

Report passing, failing and skipped counts for each backend. Inspect the package preview for the root API and `pi-extension/subagents/`, including JavaScript mirrors. Plans, sessions, generated evidence, local configuration, bundled roles and orchestration skills must remain excluded.

## Postflight

Check `git status --short` and the runner's teardown result. Remove only paths and processes identified by this run's private resource metadata. Do not scan and remove global `pi-integ-*` directories or unrelated workspaces. Retain a failed run's recovery evidence when ownership or process termination cannot be confirmed.
