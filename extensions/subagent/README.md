# Subagents

Adapted from [Pi's subagent example](https://github.com/earendil-works/pi/tree/f07218c4d4bbc12bef056a7058c3dd49dfe41abe/packages/coding-agent/examples/extensions/subagent) at v0.87.1. The upstream MIT license is in `LICENSE`.

Pinnacle's package loads the `subagent` tool when installed. To test this checkout without updating the package, use `pi -e ~/Code/pinnacle/extensions/subagent/index.ts`. Do not load both copies in one session.

The child receives a fresh conversation, project instructions, and the **task brief**, but not the parent's conversation. Give it the goal, paths, criteria, and any references it must read. The default tools are `read,grep,find,ls,codemode`. Tasks with `role: "hand"` also get `bash,edit,write`; eyes, explicit model overrides, and parent-inheriting tasks keep the read-only defaults. An explicit `tools` list replaces the defaults exactly, including codemode. Name tools explicitly for MCP access or to give a non-hand task Bash/editing access. Codemode can batch and filter calls to the allowed tools; it does not bypass the allowlist or the subagent exclusion. For deferred native MCP, include `tool_search` and every exact `mcp__<server>__<tool>` name the child may use; the allowlist also filters the search index. Tool lists are not a security sandbox: the process inherits local credentials, network, extensions, and filesystem access. Children exclude `subagent` from their tool list to avoid recursive dispatch.

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

Up to eight tasks can be requested per call and four run concurrently. Tasks default to the parent's working directory; this tool does not create or merge workspaces. Chain steps replace every `{previous}` with the previous final answer.

## Parallel hands

Use one working tree for orthogonal implementation tasks with disjoint file ownership. Each brief names the feature, files it may edit, shared contracts it must preserve, and focused verification. Different file names alone do not make tasks independent: changing an API while another task implements against it is shared work. Establish that contract first or serialize those tasks.

Keep shared files (entry points, manifests, lockfiles, generated outputs) and repo-wide formatting, history operations, and final integration checks under one writer, normally the parent. A hand that needs an out-of-scope edit reports it rather than expanding its ownership. Separate workspaces remain useful for competing implementations or experiments that need independent baselines, not as a requirement for parallel feature work. File ownership is a coordination convention, not a lock or enforced sandbox.

### Optional StackScout evidence

When StackScout tools are loaded for a Rust/TypeScript repository, use `call_graph` callers/callees/impact queries before dispatch to look for coupling between the proposed scopes. After the hands finish, the parent can use `call_graph_review({ files: [...], refresh: true })` for each feature scope to inspect changed dependencies and affected callers, then run integration tests. Refresh matters because child/Bash writes are external to the parent's tool hooks. Use a parent baseline established before dispatch: a newly launched reviewer's session-start checkpoint would miss earlier edits.

Scoped reviews show aggregate repository changes, not which hand authored them. Inspect unresolved calls, missing selectors, diagnostics, and truncation; an empty graph result does not prove independence. StackScout provides evidence, not file locking, ownership enforcement, or a complete feature-dependency model. It stays optional and is not added to default child tools. If a child needs its tools, load the extension in that child and include the exact tool names alongside the desired defaults in its `tools` override.

Child processes run with `--no-session`; only the parent keeps their results. The parent tool result records aggregate child usage for Pi's session totals, complete per-child messages, and non-message `usageEntries` in tool details. Each child's `usage` is a full Pi usage object (including token/cache counts and component costs), plus `turns`; older results used a scalar `usage.cost`. Single failures, stopped chains, launch errors, and cancellation return error-marked results with all collected usage and details rather than throwing them away. Parallel calls retain both successful and failed child usage; cancellation waits for running children and does not start queued tasks. The dispatcher collects `compaction_end` usage and usage-bearing `entry_appended` records, including cache warming and boundary compactions. Repeated entry IDs/timestamps are counted once; equal usage on distinct calls still counts. Entry timestamps and explicit provider/model metadata are retained. Compaction completion events lack timestamps and actual-model metadata, so their receipt time and current child model are used. Usage not reported before a child exits cannot be recovered. Pi 0.99.1's tree-navigation branch summaries do not emit public usage events, so those calls remain unaccounted unless the producer emits a record. Cancellation terminates each child, escalating to SIGKILL after five seconds; it does not stop a process tree. There is no built-in task timeout. Parallel output is capped at 50 KB per task in model context; complete messages are in tool details. Failure stops a single task or chain; a parallel call reports failed tasks alongside successes.

Unlike upstream, this extension accepts self-contained tasks rather than named agent profiles. Workflow instructions live in skills; the dispatcher owns processes, tool selection, results, and cancellation. No upstream workflow prompts are installed. Subagents do not gain permission to push, deploy, or perform destructive actions by delegation.
