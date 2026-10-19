# Release guide

GitHub Actions publishes this package when the version in `package.json` changes on `main`. The release workflow reads the package name and version from `package.json`, validates the package, publishes to npm, creates a matching `vX.Y.Z` tag, and creates a GitHub Release with generated notes and a link to the npm package.

The published version must be unique on npm.

## Public versioning

`pi-agent-replicate` is a new npm package name and needs its first publication. The upstream `pi-herdr-agents` package used `0.0.1` for its manual bootstrap and `0.0.2` for its first trusted-publishing release. Those versions are upstream history, not publications of this renamed package.

Do not design a release that creates a GitHub Release without a successful npm publish for a new version. The workflow publishes first, then tags and creates the GitHub Release.

## Prerequisites

You need:

- Permission to manage this repository's GitHub Actions settings and npm package access for `pi-agent-replicate`
- A clean local `main` branch

Automated release gates (run by the workflow and required locally):

```bash
npm ci
npm run lint
npm test
npm pack --dry-run
```

Manual deterministic Herdr integration (required before you push a release commit; not run in GitHub Actions):

```bash
npm run test:integration
```

Run that suite from inside Herdr. The shipped command bootstraps a separate test-owned headless Herdr server with a private socket, config, state directory, and worktree directory. It clears inherited Herdr identity and fails closed if the private endpoint cannot start, so it never falls back to the persistent user server. Normal exit and `SIGINT`, `SIGTERM`, or `SIGHUP` use one idempotent shutdown that verifies child and server process groups have exited, escalates after bounded grace, and removes only owned paths. Concurrent runs use separate endpoints and need no shared Herdr test slot. It uses real Pi and Herdr processes with the local deterministic provider, so it needs no provider credentials or network access. A focused file can be passed after `--`, for example `npm run test:integration -- test/integration/mux-surface.test.ts`.
The optional live-provider smoke test is not a release gate:

```bash
PI_TEST_MODEL="openai-codex/gpt-5.6-luna" PI_TEST_TIMEOUT=180000 npm run test:integration:live
```

Do not release from skipped Herdr tests. Confirm the package preview includes `README.md`, `CHANGELOG.md`, `AGENTS.md`, `docs/`, the package-root API files, and the files under `pi-extension/subagents/`. Confirm it excludes plans, journals, sessions, prototypes, generated evidence, and local `config.json`, and that the worktree integration tests leave no test workspace behind.

## npm authentication

### Steady state: trusted publishing (tokenless)

After the package exists on npm, steady-state releases use npm trusted publishing (OIDC). No long-lived `NPM_TOKEN` is required.

1. Open the package settings for `pi-agent-replicate` on [npmjs.com](https://www.npmjs.com/).
2. Add a trusted publisher for GitHub Actions with:
   - Organization or user: `alexshpunt`
   - Repository: `pi-agent-replicate`
   - Workflow filename: `publish.yml`
   - Allowed action: `npm publish`
3. Confirm the release job has `permissions.id-token: write` and runs on a GitHub-hosted runner (already set in `.github/workflows/publish.yml`).
4. Confirm the workflow uses the exactly pinned Node `26.3.0`, whose bundled npm supports trusted publishing.
5. Publish stays tokenless: `npm publish --access public --provenance`.

When the repository secret `NPM_TOKEN` is absent, the publish step unsets `NODE_AUTH_TOKEN` and relies on OIDC. Once the package exists, the workflow fails if `NPM_TOKEN` is still configured, so steady-state releases cannot silently keep using the bootstrap credential. Manual dispatch runs only from `main`; other refs are rejected.

### Bootstrap history

The upstream `0.0.1` publication and documented trusted publisher for `giuseppecrj/pi-herdr-agents` do not establish the renamed npm package or authorize its releases.

Only during an explicitly requested first release, configure a temporary `NPM_TOKEN` if `pi-agent-replicate` does not yet exist on npm. After that publication, revoke and remove the token, then configure the trusted publisher above. The workflow rejects `NPM_TOKEN` once the package exists. Renaming the project does not publish a package or configure its trusted publisher.

## Publish a release

Choose the semantic version increment:

- `patch`: compatible bug fixes, such as `0.0.2` to `0.0.3`
- `minor`: compatible features, such as `0.0.2` to `0.1.0`
- `major`: breaking changes, such as `0.0.2` to `1.0.0`

Create the version commit without a local tag:

```bash
git fetch --tags --prune
npm version patch --no-git-tag-version
git add package.json package-lock.json CHANGELOG.md
git commit -m "chore: release v$(node -p \"require('./package.json').version\")"
git push origin main
```

The `npm version` hook regenerates `CHANGELOG.md` with `auto-changelog`. Use `npm run changelog` to regenerate it without changing the version.

Replace `patch` with `minor` or `major` when appropriate. The push triggers the **Release** workflow, which installs dependencies, runs lint and unit tests, previews package contents, publishes to npm with provenance, creates and pushes the version tag, and creates the GitHub Release.

You can rerun a failed or incomplete release from **Actions → Release → Run workflow**. If npm already has `PACKAGE_NAME@VERSION`, the workflow reads that version's `gitHead` and continues only when it matches `GITHUB_SHA` (exact-commit retry). A foreign publish fails before tag or GitHub Release creation. Existing tags are verified to point at the release commit. The workflow does not create a GitHub Release for a version that still needs publish and failed to publish.

## Verify the release

After the workflow succeeds, inspect the published package:

```bash
npm view pi-agent-replicate
```

Test installation through Pi:

```bash
pi install npm:pi-agent-replicate
```

The package should appear at <https://pi.dev/packages/pi-agent-replicate> after the gallery indexes the npm release.

## Troubleshooting

### Tag points to another commit

The workflow stops if the matching version tag already points to a different commit. Do not move or reuse release tags. Increment the package version and push a new release commit instead.

### npm rejects authentication

Confirm that the trusted publisher matches owner `alexshpunt`, repository `pi-agent-replicate`, and workflow `publish.yml`, that the job has `id-token: write`, and that the runner is GitHub-hosted. If a release reports that `NPM_TOKEN` is bootstrap-only, remove the secret and use the trusted publisher.

### npm reports that the version already exists

If the published `gitHead` does not match this commit, the workflow fails before tagging. npm versions are immutable: increment the package version and push a new release commit. If it is a retry of the exact same commit, the workflow skips publish and continues with tag/release.

### Initial branch creation did not release

A clean repository's first push has `github.event.before` all zeroes. The workflow treats that as `release=false`. For the renamed package's first publication, follow the bootstrap instructions above. Once it exists on npm, use tokenless trusted publishing for later releases.

### The package is absent from pi.dev

Confirm that npm published the package publicly and that `package.json` contains the `pi-package` keyword. Gallery indexing may take some time.
