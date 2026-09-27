# Opening a PR after hillclimb

Work from an isolated Jujutsu workspace or Git worktree. Leave unrelated changes alone. Keep accepted commits small, ordered, and independently reviewable. Use Conventional Commits (`perf(scope): subject`, `fix(scope): subject`, etc.). Run the repository's checks and review the diff before offering it for PR. Apply [`unslop`](../../unslop/SKILL.md) to the title and body.

The PR description briefs the reviewer, not the lab notebook. Use short `## Why`, `## Scope`, `## Tradeoffs` (only if needed), `## Blast Radius`, and `## Verification` sections. Report the primary metric with units as `before → after`, and link to the decision log and measurement evidence rather than pasting the whole log. Do not claim a test or deployment that did not run.

Use `gh` for GitHub PRs when the repository uses GitHub; follow the repo's own forge workflow otherwise. Check the target branch and current state before opening a ready (not draft) PR. Do not push, create, retarget, or merge a PR without the permissions the user and repository require. In particular, ask for explicit confirmation immediately before a push to any protected branch, and never infer push permission from a request to test or optimize.

For stacks, the root targets the integration branch and each child targets its parent's branch. Create the whole stack before offering a separate CI/feedback watch. Opening a PR does not start an unattended babysitting or merge loop; perform that only when requested. Post the PR URL once created.
