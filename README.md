<p align="center">
  <img src="assets/banner.png" alt="Pi Agent Replicate: one agent branches into two copies" width="100%">
</p>

<h1 align="center">Pi Agent Replicate</h1>

<p align="center">One agent. Parallel work.</p>

<div align="center">

[![npm version](https://img.shields.io/npm/v/pi-agent-replicate)](https://www.npmjs.com/package/pi-agent-replicate)
[![MIT license](https://img.shields.io/npm/l/pi-agent-replicate)](./LICENSE)

</div>

Give your [Pi](https://github.com/earendil-works/pi) agent the ability to work in parallel in [Herdr](https://herdr.dev). It creates copies of itself for independent parts of a task, keeps working, and receives their results automatically.

Each copy starts with the current conversation, system prompt, model, thinking level and active tools. It has the context it needs to continue the work, rather than starting from scratch.

## Install

```bash
pi install npm:pi-agent-replicate
```

Start Pi inside Herdr, then restart Pi or run `/reload`. This release is tested with Pi 1.5.2.

### Herdr App

Copies also work in terminals of the Herdr App (the window plus `herdr-core`), including a WSL terminal shown by the Windows app. Replicate finds the app's command-line program on its own: `PI_HERDR_APP_CLI`, then `HERDR_APP_BIN`, then `herdr-app` on `PATH`, then the Windows installer's folder (from WSL it asks Windows for that folder and translates the path). If it cannot, set `PI_HERDR_APP_CLI` to the full path of `herdr-app` or `herdr-app.exe`.

The app names a WSL or remote core's terminals `<machine>/<id>`. Replicate learns the machine name from the app's own listing. If the listing is ambiguous or does not show the terminal, set `PI_HERDR_APP_MACHINE` to the machine name, or to an empty value for the app's own machine. Copies inherit these three variables.

## How it works

The extension adds one tool, `replicate`. The agent calls it with a task-specific name and a bounded assignment:

```typescript
replicate({
  name: "check-auth-risks",
  task: "Check authentication risks while I implement the settings change. Return concrete findings with file references.",
});
```

The name uses lowercase kebab-case. The copy works in its own Pi session and can create copies of its own. When its work and any child work finish, the result returns to the original agent automatically. The original can continue independent work or end its turn while it waits; it does not need to poll.

Use replication for substantial, self-contained blocks of a task that need no result from each other, while the original agent works on a different block. Small changes and work the original would only wait for stay with the original agent. Copies inherit the conversation and tools, but their subsequent conversations are separate.

## Where copies work

By default, copies work in the parent's current directory, including ignored files and dependencies. They do not create a worktree or branch, and there is no snapshot or automatic join. Changes are visible immediately and can remain even if a copy fails.

Because copies edit the same directory at the same time, the original agent gives each copy that changes files its own area, such as a module or a set of files. Each copy is told to change only its area, leave other changes alone, report failing checks caused by code outside its area, avoid Git operations and list the files it changed. Only the original agent commits: after the copies return, it checks the combined result and commits it. Read-only work, such as research or review, needs no separate area.

When copies need isolated files, switch to worktree mode:

```text
/replica-directory worktree
```

In worktree mode, each copy works in a separate Git worktree. It starts with a snapshot of the parent's tracked changes and non-ignored new files. Ignored files, dependencies and build outputs are not copied. On success, the host attempts to apply the copy's changes, committed or not, to the parent without changing its HEAD or staging. The result then lists the applied files: they are uncommitted changes in the parent's working directory, and the copy's worktree is removed. A conflict or failure leaves the copy's work in its worktree rather than applying partial changes, and the result names that worktree and its branch. A clean join does not guarantee the combined code is correct.

Worktree mode requires a non-bare Git checkout with a commit. Snapshots do not support unresolved index conflicts, sparse or assume-unchanged index entries, submodules or nested Git repositories. Worktrees isolate files, not shared processes, ports or databases.

Use `/replica-directory shared` to switch back, or `/replica-directory` to choose interactively. The setting is saved in `.pi/replicate.json` in the current project directory and applies to new copies only.

To use worktree mode in every project, add `--global`:

```text
/replica-directory --global worktree
```

The global setting is saved in `replicate.json` in the Pi agent directory (`~/.pi/agent` by default, or `PI_CODING_AGENT_DIR`). A project's own `.pi/replicate.json` takes precedence over it; without either file, copies use the shared directory.

## When a copy stops

A completed copy returns its summary automatically. If it fails, is interrupted or loses its process, the parent receives a failure and any available answer information. Copies do not restart automatically; the parent can create a fresh copy if needed. In shared mode, changes may already be in the shared directory; in worktree mode, failed or conflicted work remains available for recovery in the worktree the result names.

## More information

See the [documentation](docs/README.md) for technical contracts and [development instructions](docs/development.md).

## License

[MIT](LICENSE)
