# pinnacle

Personal Pi package for extensions, skills, prompts, and themes.

- [Subagents](extensions/subagent/README.md): self-contained task dispatch, with single,
  parallel, and chained execution.
- [Subagent model roles](extensions/subagent-models/README.md): `/subagent-models`
  configures an ordered eye pool and one hand model with reasoning-aware dispatch.
- [Workflows](skills/): `blast-radius`, `create-verification-skill`, `how`, `why`,
  `arena`, `architect`, `interrogate`, `hillclimb`, `show-me-your-work`, and `unslop`.
  Shared [principles](skills/principles/) are reference files, not separate skill commands.

The workflow skills adapt selected parts of [pstack](https://github.com/cursor/plugins/tree/main/pstack)
for Pi. Original material is by Lauren Tan, MIT-licensed; see
[the pstack license](skills/PSTACK-LICENSE). This package does not install pstack
or change existing skills. `create-verification-skill` writes a project-local
`.agents/skills/verify-<app>/` only when explicitly invoked in that project.
`hillclimb` has its own PR workflow and does not use `visual-pr`.
