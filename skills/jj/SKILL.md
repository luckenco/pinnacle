---
name: jj
description: Use Jujutsu (jj) effectively for everyday development, including stacked changes, bookmarks, Git remote sync, and safe history rewrites.
---

# JJ Workflow

## Goal
Help the agent execute safe, fast, low-friction version control workflows with Jujutsu.

## Default VCS Policy
If the repository has JJ metadata (`.jj/`) or is JJ/Git colocated, use `jj` instead of `git` for normal VCS tasks.
- Prefer `jj st`, `jj log`, `jj diff`, `jj new`, `jj describe`, `jj squash`, `jj split`, `jj rebase`, `jj git fetch`, and `jj git push`.
- Use raw `git` only when JJ does not support a required operation, and state that exception explicitly.

## When To Use
Use this skill when the task involves:
- Inspecting repo/change state (`jj st`, `jj log`, `jj diff`)
- Creating or updating changes (`jj describe`, `jj new`, `jj squash`, `jj split`)
- Reshaping history (`jj rebase`, `jj abandon`)
- Recovering from mistakes (`jj undo`, `jj op log`)
- Syncing with Git remotes (`jj git fetch`, `jj git push`, bookmarks)

## Core Mental Model
1. Work is a DAG of mutable changes.
2. The working copy commit (`@`) is updated automatically when commands snapshot file changes.
3. `jj new` starts the next change; `jj squash` folds current work into a parent.
4. Bookmarks are named pointers (like Git branches) used mainly for collaboration and push/fetch.
5. If a graph edit goes wrong, prefer `jj undo` first.

## Default Command Sequence
Use this loop unless the user asks for a different flow:
1. Check state: `jj st` and `jj log -r '::@' -n 8`
2. Describe current work: `jj describe -m "<message>"`
3. Make/edit files
4. Review: `jj diff --git`
5. Start next change: `jj new -m "<next message>"` (or plain `jj new`)
6. Refine history as needed: `jj squash`, `jj split`, `jj rebase`
7. Sync: `jj git fetch` then `jj git push --bookmark <name>`

## Practical Patterns

### Update current change
- Edit files, then run `jj st` or `jj diff` (snapshots happen automatically).
- Keep message current with `jj describe -m "<message>"`.

### Start a new stacked change
- `jj new -m "<message>"` to create a child change and move `@` to it.

### Fold fixups into previous change
- From fixup change: `jj squash --into @-`
- For partial fold: `jj squash --into @- --interactive`

### Split one large change
- `jj split` (interactive by default) and put selected hunks in the first change.

### Move a change in the stack
- `jj rebase -r <rev> -d <destination>`
- Re-check with `jj log -r '::@' -n 12`

### Recover quickly
- Undo last operation: `jj undo`
- Inspect operation history: `jj op log`
- Restore/target prior operation only when needed: `jj --at-op <opid> st`

## Bookmarks And Git
- Create/move bookmark to publish work: `jj bookmark set <name> -r <rev>`
- Push bookmark: `jj git push --bookmark <name>`
- Track remote bookmark when needed: `jj bookmark track <name>@origin`
- Verify local/remote positions: `jj bookmark list`

Note: JJ does not have an "active branch"; the working copy is tied to `@`, not a bookmark checkout.

## Safety Rules
1. Always inspect before/after graph edits with `jj st` and `jj log`.
2. Prefer `jj undo` over ad-hoc repair commands.
3. Avoid rewriting clearly shared immutable history unless explicitly requested.
4. When unsure about flags for local JJ version, run `jj help <command>`.

## Quick Reference
- State: `jj st`, `jj log`, `jj show`, `jj diff`
- Authoring: `jj describe`, `jj new`, `jj commit`
- Rewrite: `jj squash`, `jj split`, `jj rebase`, `jj abandon`
- Recovery: `jj undo`, `jj op log`, `jj op restore`
- Remote: `jj git fetch`, `jj git push`, `jj bookmark ...`

## References
- JJ docs (latest): https://docs.jj-vcs.dev/latest/
- JJ tutorial: https://docs.jj-vcs.dev/latest/tutorial/
- JJ Git comparison: https://docs.jj-vcs.dev/latest/git-comparison/
- JJ operation log docs: https://docs.jj-vcs.dev/latest/operation-log/
- Jujutsu for busy devs: https://maddie.wtf/posts/2025-07-21-jujutsu-for-busy-devs#entry-1
