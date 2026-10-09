# Worktree subagents

A model-facing `subagent` launch may request an isolated Git worktree:

```json
{
  "name": "issue-42-build",
  "agent": "implementer",
  "task": "Implement the approved change, test it, commit it, and report the SHA.",
  "worktree": { "branch": "issue/42", "base": "HEAD" }
}
```

The `subagent` tool requires an existing role; this example assumes you have an `implementer` role.

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

`subagent_resume` resumes a session in an ordinary pane. It does not reattach ownership of a retained worktree.

## Cleanup

Only remove a worktree after review and integration. Verify its path and branch first, then use your normal Git or Worktrunk cleanup procedure. Never delete `.git/worktrees` entries by hand.
