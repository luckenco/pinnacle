# pinnacle

Personal Pi package for extensions, skills, prompts, and themes.

Try Pinnacle without adding it to your Pi settings:

```bash
pi -e git:github.com/luckenco/pinnacle
```

This loads Pinnacle for this run. Your existing Pi configuration still applies.

## Extensions

- [`cloak`](extensions/cloak/): Masks configured secrets in tool results before they enter the conversation.
- [`codex-fast`](extensions/codex-fast/): Adds `/fast` to persistently request priority service for OpenAI ChatGPT OAuth models and show its status.
- [`git-interceptor`](extensions/git-interceptor.ts): Prevents Git editor hangs and blocks agents from bypassing hooks with `--no-verify`.
- [`notify`](extensions/notify.ts): Sends an OSC 777 desktop notification when an agent finishes and waits for input.
- [`session-breakdown`](extensions/session-breakdown.ts): Adds `/session-breakdown` for interactive 7/30/90-day and 1-year (365-day) session, token, model, and cost summaries.
- [`skill-toggle`](extensions/skill-toggle/): Adds `/toggle-skills` to choose, per repository, which loaded skills are visible to the model while keeping `/skill:<name>` commands available.
- [`skills`](extensions/skills.ts): Adds `/skills` to search loaded skills by name or description and prepare a `/skill:<name>` invocation in the editor.
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

- **Eyes** are an ordered pool of models for exploration, design, review, judgment, and synthesis. Each eye has its own reasoning level. Skills use the pool in order before choosing more models if needed.
- **Hand** is the required model for bounded implementation tasks. It has its own reasoning level, even if you use the same model as an eye.

Subagent tasks request `role: "eye"` or `role: "hand"`. Use `eyeIndex` to select an eye by its 1-based position. The dispatcher checks the model and reasoning level before launch and reports an error if either is unavailable. Direct calls can still specify a `model` or inherit the parent's model. Child defaults include codemode and read-only file tools; hands also get Bash, edit, and write. An explicit `tools` list replaces those defaults. Pi warns at session start until you configure at least one eye and a hand. See the [model-role guide](extensions/subagent-models/README.md) and [subagent tool guide](extensions/subagent/README.md) for details.

### Parallel implementation

Parallel hands can share one working tree when their features are orthogonal and their file ownership is disjoint. Establish shared contracts first; keep shared files, history operations, and final integration under one writer. Separate workspaces are for competing implementations or experiments needing independent baselines, not a default requirement for parallel feature work.

StackScout can optionally provide caller/dependency evidence before dispatch and scoped impact reviews afterward in Rust/TypeScript repositories. It does not enforce ownership or prove independence. See [parallel hands and StackScout guidance](extensions/subagent/README.md#parallel-hands).

## Scripts and supporting assets

- [`intercepted-commands/`](intercepted-commands/): Provides the `pip`, `pip3`, `poetry`, `python`, and `python3` shims used by the `uv` extension.
- [`skills/principles/`](skills/principles/): Holds shared workflow principles referenced by skills rather than exposed as separate skills.
- [`skills/show-me-your-work/scripts/log.sh`](skills/show-me-your-work/scripts/log.sh): Appends sanitized rows to a decision log with timestamps and spreadsheet-formula protection.
- [`doom-peacock`](themes/doom-peacock.json), [`gruvbox-dark-hard`](themes/gruvbox-dark-hard.json), and [`gruvbox-dark`](themes/gruvbox-dark.json): Bundled Pi themes.
- [`prompts/`](prompts/): Reserved for package prompt templates and currently empty.

## Lint and format tooling

- [`tools/oxlint/anti-slop/`](tools/oxlint/anti-slop/): Vendors the anti-slop Oxlint rules, including the optional Effect rules and their upstream license and provenance.
- [`.oxlintrc.json`](.oxlintrc.json): Enables the generic anti-slop rules and ignores installed agent assets and vendored rules.
- [`.oxfmtrc.json`](.oxfmtrc.json): Configures Oxfmt and excludes vendored rules, agent assets, and Markdown documentation.
- `bun run lint` runs Oxlint; `bun run format` formats with Oxfmt; `bun run check` checks Oxfmt formatting, Oxlint, and TypeScript.

## Origins

Pinnacle borrows ideas from [dmmulroy's dotfiles](https://github.com/dmmulroy/.dotfiles/tree/main) and [Cursor's pstack](https://github.com/cursor/plugins/tree/main/pstack). Some extensions link to their specific sources in the code. The workflow skills adapt selected pstack material for Pi. Lauren Tan wrote the original under the MIT license, preserved in [skills/PSTACK-LICENSE](skills/PSTACK-LICENSE).

This package does not install pstack or change existing skills. `create-verification-skill` writes a project-local `.agents/skills/verify-<app>/` only when you invoke it in that project. `hillclimb` has its own PR workflow and does not use `visual-pr`.
