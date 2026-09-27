# Subagents

Pi's official subagent example, packaged for Pinnacle. Requires Pi 0.87.1 or newer.

## Load and use

The Pinnacle package discovers `index.ts` automatically after this change is
published and the installed package is updated. To use the local checkout now,
without changing your managed settings:

```sh
pi -e ~/Code/pinnacle/extensions/subagent/index.ts
```

Once installed through the package, omit `-e` to avoid loading it twice.
The existing conversation does not gain the tool until its extensions reload.

Ask Pi directly:

- "Use scout to trace authentication. Return file paths and the request flow."
- "Run two scouts in parallel: one for the API, one for the mobile client."
- "Chain scout then planner; pass the scout's findings to the planner. Stop before implementation."
- "Use reviewer on this diff and its surrounding source. Report evidence, not speculative improvements."

The `subagent` tool supports:

```json
{ "agent": "scout", "task": "Trace authentication" }
```

```json
{ "tasks": [
  { "agent": "scout", "task": "Trace API auth", "cwd": "/path/to/api" },
  { "agent": "scout", "task": "Trace mobile auth", "cwd": "/path/to/mobile" }
] }
```

```json
{ "chain": [
  { "agent": "scout", "task": "Find the auth implementation" },
  { "agent": "planner", "task": "Plan the requested change using these findings: {previous}" }
] }
```

## Agents and models

Bundled profiles work without setup:

| Agent | Tools | Purpose |
|---|---|---|
| `scout` | read, grep, find, ls | Reconnaissance and compact handoff |
| `planner` | read, grep, find, ls | Implementation plan, no edits |
| `reviewer` | read, grep, find, ls | Review supplied scope/diff and source |
| `worker` | read, bash, edit, write, grep, find, ls | Bounded implementation work |

All inherit the dispatching session's model and thinking level. To select another
model or customize a role, put an agent Markdown file in `~/.pi/agent/agents/`
(or `$PI_CODING_AGENT_DIR/agents/`). User profiles override bundled names:

```markdown
---
name: second-reviewer
description: Independent review using another model
tools: read, grep, find, ls
model: provider/model-id
---
Review the supplied change. Inspect surrounding source and cite evidence.
```

Use an installed model ID from `pi --list-models`. An explicit `model` overrides
the parent's model; its reasoning can be selected with the `:high`-style suffix.

Default `agentScope: "user"` includes bundled and user profiles only. `"both"`
also loads the nearest ancestor `.pi/agents/`, whose names override user profiles.
`"project"` loads only that project directory. Untrusted project profiles require
interactive confirmation; headless requests fail unless already trusted or the
caller explicitly sets `confirmProjectAgents: false` after approval.

## Boundaries

- Each task runs in a separate Pi process with fresh conversation context. Include
  the goal, scope, relevant paths/diff, and completion criteria in the task.
- Children load their own Pi configuration and applicable repo instructions.
  Parent-only command-line extensions are not automatically forwarded.
- Context is isolated; the filesystem, credentials, and network are not sandboxed.
  Read-only profiles restrict built-in tools, not arbitrary installed extensions.
- Parallel mode accepts up to eight tasks, with four running at once. Give parallel
  writers separate workspaces; this extension does not create or merge them.
- Children exclude the `subagent` tool, preventing ordinary recursive tool dispatch.
  A worker with Bash can still launch programs; this is not a security boundary.
- Cancellation sends SIGTERM, then SIGKILL after five seconds if needed. It targets
  the Pi child, not an OS sandbox/process tree. There is no automatic task timeout.
- Child sessions are not persisted. Results and usage summaries appear in the
  parent's tool details. Parallel output is capped at 50 KB per task in model context.
- Delegation does not authorize pushes, merges, deployments, or destructive actions.

## Upstream

Source: [Pi subagent example](https://github.com/earendil-works/pi/tree/f07218c4d4bbc12bef056a7058c3dd49dfe41abe/packages/coding-agent/examples/extensions/subagent),
Pi **v0.87.1**, commit `f07218c4d4bbc12bef056a7058c3dd49dfe41abe`.
The upstream MIT license is preserved in `LICENSE`.

Local changes: bundled-profile discovery and precedence, model inheritance in
profiles, read-only scout/reviewer tools, explicit worker permissions, child
dispatch exclusion, headless trust confirmation, cancellation cleanup/escalation,
UTF-8 stream decoding, multi-block text output, proper tool errors for failed
single/chain runs, discovery tolerance for malformed YAML, and repository
formatting/types. Upstream workflow prompt templates are not
included; single, parallel, and chain tool modes remain available.

Update deliberately from a reviewed upstream revision rather than importing a
moving runtime example. Run Pinnacle's checks and tests after updating. The tests
use a deterministic subprocess fixture; real provider access is a separate check.
