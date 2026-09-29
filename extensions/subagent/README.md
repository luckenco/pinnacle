# Subagents

Adapted from [Pi's subagent example](https://github.com/earendil-works/pi/tree/f07218c4d4bbc12bef056a7058c3dd49dfe41abe/packages/coding-agent/examples/extensions/subagent) at v0.87.1. The upstream MIT license is in `LICENSE`.

Pinnacle's package loads the `subagent` tool when installed. To test this checkout without updating the package, use `pi -e ~/Code/pinnacle/extensions/subagent/index.ts`. Do not load both copies in one session.

The child receives a fresh conversation, project instructions, and the **task brief**, but not the parent's conversation. Give it the goal, paths, criteria, and any references it must read. The default tools are `read,grep,find,ls`. Pass `tools` explicitly for Bash, editing, or MCP access. Tool lists are not a security sandbox: the process inherits local credentials, network, extensions, and filesystem access. Children exclude `subagent` from their tool list to avoid recursive dispatch.

Examples of the model-callable tool input:

```json
{ "task": { "task": "Trace the auth flow. Cite paths and identify gaps." } }
```

```json
{ "tasks": [
  { "name": "candidate A", "task": "Propose a design from these constraints: ...", "role": "eye", "cwd": "/path/to/workspace-a" },
  { "name": "candidate B", "task": "Propose a design from these constraints: ...", "role": "eye", "cwd": "/path/to/workspace-b" },
  { "name": "overflow", "task": "Propose another design: ...", "model": "provider/model-id", "cwd": "/path/to/workspace-c" }
] }
```

```json
{ "chain": [
  { "task": "Locate the relevant code and summarize the flow." },
  { "task": "Evaluate the design using these findings: {previous}" }
] }
```

`task`, `tasks`, and `chain` are mutually exclusive. Each task can specify `name`, `cwd`, `role`, `eyeIndex`, `model`, and `tools`. `role: "eye"` consumes the configured eye pool in order; `eyeIndex` selects one 1-based eye directly. `role: "hand"` uses the configured hand. Both apply the role's saved reasoning level. A task cannot combine `role` and `model`. Eye seats beyond the pool must use an explicit `model`, chosen by the orchestrator; they are never silently substituted or cycled. Tasks with neither inherit the active model and thinking level. Use `pi --list-models` for explicit provider/model IDs.

Role dispatch requires at least one configured eye and a hand, even if that call only uses one role. It checks configured assignments against Pi's available catalog and supported reasoning levels before launching any child. An unavailable model, stale reasoning level, incomplete configuration, or eye overflow rejects the whole call. The tool publishes the resolved roster before launch. Direct `model` overrides and parent inheritance retain their previous behavior.

Up to eight tasks can be requested per call and four run concurrently. Give parallel writers separate workspaces; this tool does not create or merge them. Chain steps replace every `{previous}` with the previous final answer.

Child processes run with `--no-session`; only the parent keeps their results. The parent tool result records aggregate child usage for Pi's session totals and complete per-child messages in tool details. Cancellation terminates each child, escalating to SIGKILL after five seconds; it does not stop a process tree. There is no built-in task timeout. Parallel output is capped at 50 KB per task in model context; complete messages are in tool details. Failure stops a single task or chain; a parallel call reports failed tasks alongside successes.

Unlike upstream, this extension accepts self-contained tasks rather than named agent profiles. Workflow instructions live in skills; the dispatcher owns processes, tool selection, results, and cancellation. No upstream workflow prompts are installed. Subagents do not gain permission to push, deploy, or perform destructive actions by delegation.
