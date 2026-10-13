---
description: Implement a bounded task with verification and focused review
argument-hint: "<task>"
---

Implement this task: $ARGUMENTS

1. Read the applicable repository instructions and inspect relevant code and working-copy state. Briefly state observable success and how you will verify it. Ask only when ambiguity materially affects scope, behavior, or authorization; otherwise proceed with reasonable assumptions.
2. Implement the bounded task with focused changes, preserving unrelated work. Stay within the requested authorization; committing, pushing, and deploying require an explicit request.
3. Run repository-required checks and verify the changed behavior with appropriate tests or direct execution. Own routine debugging and fix failures caused by your changes. Distinguish preexisting failures from regressions.
4. For nontrivial changes, request one focused independent review of correctness, regressions, and missing coverage. Give the reviewer the task, diff, and verification evidence. If an independent reviewer is unavailable, make a separate review pass and disclose that limitation.
5. Validate findings before acting, fix confirmed issues within scope, and rerun affected checks. Follow up only on unresolved concrete risks rather than restarting broad review. Pause for domain ambiguity, risky side effects beyond authorization, or genuinely blocked verification; report the blocker and the smallest decision or access needed.
6. Finish with a concise, evidence-based handoff: what changed, checks run and results, skipped or blocked verification, and remaining risks or work. Report commit, push, or deployment status only when relevant, without implying actions that were not requested or performed.
