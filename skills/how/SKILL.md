---
name: how
description: "Use for \"how does X work\", code walkthroughs before changing something, and placement / ownership / layering questions (\"where should this live\", \"which package owns this\", \"is this the right layer\"). Explains subsystem architecture, runtime flow, onboarding mental models. Use why for motivation."
disable-model-invocation: true
---

# How

Explore the codebase to answer "how does X work?" questions. Produce architectural explanations at the level of a senior engineer onboarding onto a subsystem, enough to build a working mental model, not so much that it reads like annotated source code.

Use Pinnacle's `subagent` tool. Exploration and explanation tasks use configured eyes and their saved reasoning. Fill parallel seats from the eyes in priority order with `role: "eye"`; when a fan-out exceeds the pool, choose whether each overflow seat inherits the parent or uses an explicit available model. Each task is self-contained and names the question, paths, and its reference prompt. Use the default read-only tools.

## Step 1. Assess Complexity

If the scope is ambiguous, state your interpretation and explore. The user can redirect.

- **Simple** (a single module, a small utility, a narrow question such as "how does function X work"): no explorers. One explainer explores and explains in a single pass. Go to Step 2b.
- **Complex** (a subsystem spanning multiple files or services, a cross-cutting feature, a full architectural overview): spawn parallel explorers first, then hand off to the explainer. Go to Step 2a.

When in doubt, take the simple path.

## Step 2a. Explore (complex questions only)

Decompose the question into 2 to 4 exploration angles, each a distinct slice of the subsystem. Launch one `subagent` parallel call with a `tasks` entry per angle, pointing each brief at `references/explorer-prompt.md`. Then go to Step 3.

## Step 2b. Direct Explain (simple questions)

Run one `subagent` task with `role: "eye"` to explore and explain in one pass. Use `references/explainer-prompt.md` without the explorer-findings section. Go to Step 4.

## Step 3. Synthesize (complex questions only)

Once all explorers have returned, run one `subagent` task with `role: "eye"` to synthesize their findings into one explanation. Build its prompt from `references/explainer-prompt.md` with every explorer's findings filled in. Report any failed explorer as a coverage gap, not a successful trace.

## Step 4. Present

Present the explainer's output to the user. Light edits for clarity or context from the conversation are fine. Do not substantially rewrite it.

## Output Format

The explanation uses the sections defined in `references/explainer-prompt.md`, dropping any that do not apply: Overview, Key Concepts, How It Works, Where Things Live, Gotchas.
