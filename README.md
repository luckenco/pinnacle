# pinnacle

Personal Pi package for extensions, skills, prompts, and themes.

## Extensions

- [`cloak`](extensions/cloak/): Masks configured secrets in tool results before they enter the conversation.
- [`codex-fast`](extensions/codex-fast/): Adds `/fast` to persistently request OpenAI Codex priority service and show its status.
- [`git-interceptor`](extensions/git-interceptor.ts): Prevents Git editor hangs and blocks agents from bypassing hooks with `--no-verify`.
- [`notify`](extensions/notify.ts): Sends an OSC 777 desktop notification when an agent finishes and waits for input.
- [`session-breakdown`](extensions/session-breakdown.ts): Adds `/session-breakdown` for interactive 7/30/90-day and 1-year (365-day) session, token, model, and cost summaries.
- [`skill-toggle`](extensions/skill-toggle/): Adds `/toggle-skills` to choose, per repository, which loaded skills are visible to the model while keeping `/skill:<name>` commands available.
- [`subagent`](extensions/subagent/): Dispatches self-contained single, parallel, or chained tasks in separate Pi processes.
- [`subagent-models`](extensions/subagent-models/): Adds `/subagent-models` and resolves subagent eye and hand roles with explicit reasoning levels.
- [`uv`](extensions/uv.ts): Replaces the Bash tool with one that redirects Python, pip, and Poetry workflows through `uv`.
- [`worker-configuration-guard`](extensions/worker-configuration-guard.ts): Blocks manual changes to generated `worker-configuration.d.ts` files and directs agents to `wrangler types`.

## Skills

- [`architect`](skills/architect/SKILL.md): Designs types, signatures, and module boundaries through competing sketches before implementation.
- [`arena`](skills/arena/SKILL.md): Runs multiple independent attempts at one task, picks a base, grafts the strongest ideas, and verifies the result.
- [`blast-radius`](skills/blast-radius/SKILL.md): Traces what a change could break outside its diff and proves the key safety claim by running real code.
- [`create-verification-skill`](skills/create-verification-skill/SKILL.md): Generates a project-local skill that verifies an application through realistic user-facing behavior.
- [`github`](skills/github/SKILL.md): Uses the `gh` CLI for GitHub issues, pull requests, workflow runs, and API queries.
- [`hillclimb`](skills/hillclimb/SKILL.md): Improves one measured metric through isolated hypotheses, keep-or-revert experiments, and regression gates.
- [`how`](skills/how/SKILL.md): Explores a codebase and explains subsystem architecture, runtime flow, ownership, and layering.
- [`interrogate`](skills/interrogate/SKILL.md): Sends the same code review to multiple models and synthesizes an adversarial verdict.
- [`jj`](skills/jj/SKILL.md): Guides everyday Jujutsu workflows, including stacked changes, bookmarks, synchronization, and safe history edits.
- [`show-me-your-work`](skills/show-me-your-work/SKILL.md): Maintains an append-only decision log and audits it against evidence and the session transcript.
- [`unslop`](skills/unslop/SKILL.md): Removes recognizable AI writing habits from prose.
- [`uv`](skills/uv/SKILL.md): Standardizes Python dependency management and execution on `uv` instead of pip, Python, or virtualenv commands.
- [`why`](skills/why/SKILL.md): Investigates code rationale across source history and available organizational evidence, then returns a cited confidence-ranked explanation.

## Eye and hand model routing

Run `/subagent-models` to configure the models used by Pinnacle workflows:

- **Eyes** are an ordered pool of one or more capable models used for exploration, design, review, judgment, and synthesis; every eye has its own explicit reasoning level, and skills consume the pool in priority order before choosing workflow-specific overflow models.
- **Hand** is one required model used for bounded implementation work, with a separate reasoning level even when the same model is also an eye.

Subagent tasks request `role: "eye"` or `role: "hand"`; `eyeIndex` can select a specific 1-based eye. The dispatcher validates the configured model and reasoning level before launch and fails visibly rather than silently substituting an unavailable assignment. Exact `model` overrides and parent-model inheritance remain available for direct calls and workflow overflow. Pi warns at session start until at least one eye and a hand are configured. See the [model-role guide](extensions/subagent-models/README.md) and [subagent tool guide](extensions/subagent/README.md) for details.

## Scripts and supporting assets

- [`intercepted-commands/`](intercepted-commands/): Provides the `pip`, `pip3`, `poetry`, `python`, and `python3` shims used by the `uv` extension.
- [`skills/principles/`](skills/principles/): Holds shared workflow principles referenced by skills rather than exposed as separate skills.
- [`skills/show-me-your-work/scripts/log.sh`](skills/show-me-your-work/scripts/log.sh): Appends sanitized rows to a decision log with timestamps and spreadsheet-formula protection.
- [`doom-peacock`](themes/doom-peacock.json), [`gruvbox-dark-hard`](themes/gruvbox-dark-hard.json), and [`gruvbox-dark`](themes/gruvbox-dark.json): Bundled Pi themes.
- [`prompts/`](prompts/): Reserved for package prompt templates and currently empty.

## Origins

Pinnacle regularly draws inspiration from [dmmulroy's dotfiles](https://github.com/dmmulroy/.dotfiles/tree/main) and [Cursor's pstack](https://github.com/cursor/plugins/tree/main/pstack). Some extensions retain more specific source links alongside their code. The workflow skills adapt selected pstack material for Pi; the original is by Lauren Tan and MIT-licensed, with its license preserved in [skills/PSTACK-LICENSE](skills/PSTACK-LICENSE). This package does not install pstack or change existing skills. `create-verification-skill` writes a project-local `.agents/skills/verify-<app>/` only when explicitly invoked in that project. `hillclimb` has its own PR workflow and does not use `visual-pr`.
