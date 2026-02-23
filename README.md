# pinnacle

A personal Pi package that bundles practical coding-agent workflows:
- Safety guardrails for risky bash tool calls.
- Workflow slash commands (`/plan`, `/review`).
- Reusable skills and prompt templates.

## What This Package Does

`pinnacle` provides an opinionated baseline for day-to-day coding with Pi while keeping provider/model defaults untouched.

## Install

### Global install

```bash
pi install git:github.com/<your-user>/pinnacle
```

### Project-local install

```bash
pi install -l git:github.com/<your-user>/pinnacle
```

### Local path install (for development)

```bash
pi install -l /absolute/path/to/pinnacle
```

## Resource List

### Extensions
- `extensions/safety-guard.ts`
- `extensions/workflow-commands.ts`

### Skills
- `skills/repo-kickoff/SKILL.md`
- `skills/review-checklist/SKILL.md`
- `skills/commit-discipline/SKILL.md`

### Prompts
- `prompts/plan.md`
- `prompts/review.md`
- `prompts/ship.md`

## Safety Model and Override Notes

- Dangerous bash commands are either blocked or require explicit confirmation.
- Non-interactive mode blocks confirmation-required commands by default.
- To customize behavior, edit `extensions/safety-guard.ts` rule lists.

## Update and Uninstall

```bash
pi update
pi remove git:github.com/<your-user>/pinnacle
```

## Customize Safely Without Touching Global Defaults

1. Prefer project-local installs (`pi install -l ...`) for repository-specific behavior.
2. Keep your existing global `~/.pi/agent/settings.json` provider/model defaults unchanged.
3. Extend this package by adding files under `extensions/`, `skills/`, or `prompts/`.

## Development

```bash
bun install
bun run check
bun run lint
bun run format
bun run test
```
