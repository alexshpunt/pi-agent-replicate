# Worktree subagents

The retained package-root API and internal launcher support isolated Git worktrees. The model-facing `replicate` tool does not create worktrees; its copies share the caller's checkout.

For example, a tree consumer can launch:

```typescript
tree.launch({
  name: "issue-42-build",
  agent: "implementer",
  task: "Implement the approved change, test it, commit it, and report the SHA.",
  worktree: { branch: "issue/42", base: "HEAD" },
});
```

This example assumes an existing `implementer` role. Bare API children are also supported.

`cwd` selects the source repository. `base` resolves to an exact commit before creation and defaults to committed `HEAD`. The child starts at the Herdr-created worktree root.

## Guarantees

1. Worktrees are opt-in per launch.
2. Parent uncommitted and untracked files are not copied.
3. An ownership manifest is written before Herdr creates resources.
4. Herdr creates the workspace without changing parent focus.
5. Success, failure, and help outcomes retain the workspace.
6. Git inspection failures are reported as unknown, never guessed clean.
7. The extension never pushes, merges, cherry-picks, switches the parent checkout, or removes worktrees and branches.

The manifest lives under the parent session artifacts:

```text
<session-dir>/artifacts/<session-id>/worktree-runs/<child-id>.json
```

## Review

After completion, inspect the reported path and Git state. Review the diff and commits before integrating. The parent owns merge, publication, and cleanup.

Useful Git commands:

```bash
git -C <worktree-path> status --short
git -C <worktree-path> log --oneline <base-sha>..HEAD
git -C <worktree-path> diff <base-sha>...HEAD
```

## Recovery

If creation returns an ambiguous Herdr error, the extension may reconcile one exact branch match from Herdr's worktree list. It never guesses among multiple matches. A failed launch retains any verified worktree and records the error in its manifest.

The retained internal resume path opens an ordinary pane. It does not reattach ownership of a retained worktree.

A parent or child may move through Teleport without transferring or discarding the original worktree ownership. The session's binding still resolves the launch manifest and pending answer. The new session location is used for lifecycle observation and delivery; the retained checkout remains the original launch's review target. Herdr process loss does not authorize closing an unrelated pane that reuses an old ID.

## Cleanup

Only remove a worktree after review and integration. Verify its path and branch first, then use your normal Git or Worktrunk cleanup procedure. Never delete `.git/worktrees` entries by hand.
