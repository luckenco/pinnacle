---
name: arena
description: "Spawn N parallel candidates at the same task, pick a base, graft the strongest parts of the losers into it. Use for /arena, 'arena this', 'throw it in the arena', or when one attempt at a non-trivial artifact would lock in the wrong shape."
disable-model-invocation: true
---

# Arena

Fan out N parallel attempts at the same task. Read every candidate end to end. Pick the strongest as the base. Graft the best ideas from the others into it. Verify the synthesized result.

## Start

Track these phases in the current conversation before launching anything (or in a task list if one is available).

1. Frame
2. Fan out
3. Cross-judge
4. Pick
5. Graft
6. Verify

## Phase A: Frame

The N candidates will receive the same prompt, so the prompt is the contract.

1. State the artifact each candidate is producing.
2. Derive the rubric. State what success looks like for *this* task, then turn it into 3-6 concrete gradeable criteria. The rubric is the picker's tool in Phase D. Candidates only see the task.
3. Fill runner seats from the configured eyes in priority order, using `role: "eye"`; the system prompt lists the pool. If N exceeds that pool, choose explicit overflow models from those actually available in Pi (`pi --list-models`) using the existing judgment: prefer different provider families for judgment-heavy tasks and the active model when no alternatives exist. Same model N times is fine when generation matters more than model diversity. Record the actual model for every seat; repeated routes are not model diversity.
4. Assign output paths. The parent prepares distinct workspaces *before* dispatch: temporary directories for design artifacts, separate Jujutsu workspaces or Git worktrees for code changes. Give each candidate its own `cwd` and output path. Read [separate-before-serializing-shared-state](../principles/principle-separate-before-serializing-shared-state.md). Parallel writers must not share a working tree.

## Phase B: Fan out

Launch one parallel `subagent` call with N `tasks` entries (maximum eight, four concurrent). Each self-contained brief names the task, shared grounding paths, its own output path, and instructions to produce both artifact and short rationale. Supply `cwd` and `tools: ["read", "grep", "find", "ls", "bash", "edit", "write"]` for writers. The parent waits for all results; a tool response is not a background job.

Each rationale names the alternatives the candidate considered and what it rejected.

If a candidate fails to produce output, proceed with N-1 and note the dropout in the synthesis record.

## Phase C: Cross-judge

After all candidates finish, choose a configured eye, preferring one from a different family from the parent, and use its `eyeIndex`. Do not reserve an unused eye for judging: the judge may have also produced a candidate, and that is not independent judgment of its own candidate. Run one read-only `subagent` judge (default tools). Provide the rubric and all candidate paths by label. The judge scores each criterion and recommends a base with rationale. The parent reads the candidates too; never judge artifacts while writers are still running. If an independent model is unavailable, say so.

## Phase D: Pick a base

Read every candidate end to end before picking.

Score each candidate against the rubric criterion by criterion, not on holistic feel. Compare against the cross-judge. Agreement on the base confirms the pick. Disagreement means one of you is biased or the rubric was ambiguous. Read both rationales before deciding.

Pick the base on which candidate a future maintainer can extend most easily without breaking invariants. Prefer the cleaner boundary or smaller API when two feel tied, per [laziness-protocol](../principles/principle-laziness-protocol.md).

Record the pick and the reason in a short synthesis note alongside the base artifact, including the cross-judge's verdict.

## Phase E: Graft

Walk each losing candidate once more and identify what is worth porting into the base. The signal is usually one or two things per candidate, not most of it.

Fold each graft in by hand, per [redesign-from-first-principles](../principles/principle-redesign-from-first-principles.md). Don't paste mechanically. The result has to remain coherent under one mental model.

Record what was grafted, from which candidate, and what was rejected and why.

When N candidates converge on the same shape, that is a strong agreement signal. Note the convergence in the record and ship the consensus shape. No graft is needed. When N candidates wildly diverge, Phase A was under-specified. Reframe and re-run rather than averaging the divergence.

## Phase F: Verify

The synthesized artifact has to hold up under the same scrutiny as any other output, per [prove-it-works](../principles/principle-prove-it-works.md).

If verification surfaces a problem the arena did not catch, either Phase A was wrong (re-frame and re-run) or one candidate caught it and you missed the graft (go back to Phase E). Don't paper over.

## Outputs

One synthesized artifact. One short synthesis note alongside, naming the base, the grafts (with source candidate), the rejections, the dropouts if any, and the verification result.
