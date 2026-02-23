---
name: commit-discipline
description: Keep change sets clean, focused, and easy to review.
---

# Commit Discipline

## Rules
1. One intent per commit.
2. Avoid unrelated formatting churn.
3. Include tests with behavioral changes.
4. Write commit messages in imperative mood with a clear scope.

## Pre-Commit Checks
- Run lint and type checks.
- Re-scan changed files for accidental secret leakage.
- Confirm docs or README updates if behavior changed.
