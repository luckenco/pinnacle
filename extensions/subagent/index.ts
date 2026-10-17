// Adapted from Pi's subagent example (v0.87.1). See README.md for source and license.
import { type ChildProcessByStdio, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import type { Readable } from "node:stream";
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { Message, Usage } from "@earendil-works/pi-ai";
import type {
  CompactionResult,
  ExtensionAPI,
  ExtensionContext,
  SessionEntry,
} from "@earendil-works/pi-coding-agent";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { type Static, Type } from "typebox";
import { Value } from "typebox/value";

const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;

const MAX_TASKS = 8;

const MAX_CONCURRENT = 4;

const MAX_OUTPUT_BYTES = 50 * 1024;

const EnabledSchema = Type.Object({ enabled: Type.Boolean() });

function loadEnabled(agentDir: string): boolean {
  try {
    const value: unknown = JSON.parse(
      readFileSync(join(agentDir, "extensions", "subagent.json"), "utf8"),
    );

    return Value.Check(EnabledSchema, value) ? value.enabled : true;
  } catch {
    return true;
  }
}

function saveEnabled(agentDir: string, enabled: boolean): void {
  const directory = join(agentDir, "extensions");
  const path = join(directory, "subagent.json");
  const temp = `${path}.${randomUUID()}.tmp`;
  mkdirSync(directory, { recursive: true });

  try {
    writeFileSync(temp, `${JSON.stringify({ enabled }, null, 2)}\n`, { flag: "wx", mode: 0o600 });
    renameSync(temp, path);
  } finally {
    rmSync(temp, { force: true });
  }
}

const Task = Type.Object({
  task: Type.String({
    description: "Self-contained brief: goal, scope, relevant paths, evidence, and output",
  }),
  name: Type.Optional(Type.String({ description: "Label used to identify this result" })),
  cwd: Type.Optional(
    Type.String({
      description:
        "Working directory; defaults to parent cwd. Parallel writers need orthogonal tasks and disjoint file ownership.",
    }),
  ),
  model: Type.Optional(
    Type.String({
      description:
        "provider/model, from the listed subagent models when listed; omit for the parent's",
    }),
  ),
  thinking: Type.Optional(
    Type.Union(
      THINKING_LEVELS.map((level) => Type.Literal(level)),
      { description: "Reasoning level; omit for the listed or default level" },
    ),
  ),
  tools: Type.Optional(
    Type.Array(Type.String(), {
      minItems: 1,
      description:
        "Exact tool allowlist; omit for Pi's default tools. For deferred MCP, include tool_search and each exact mcp__<server>__<tool> name.",
    }),
  ),
});

const Params = Type.Object({
  task: Type.Optional(Task),
  tasks: Type.Optional(
    Type.Array(Task, { description: "Independent tasks run in parallel (max 8; 4 at a time)" }),
  ),
  chain: Type.Optional(
    Type.Array(Task, {
      description: "Sequential tasks; {previous} inserts the previous final answer",
    }),
  ),
});

type Brief = Static<typeof Task>;

type Mode = "single" | "parallel" | "chain";

type Assignment = { model?: string; thinking?: ThinkingLevel };

type UsageRecord = {
  type: "usage" | "compaction" | "branch_summary";
  id?: string;
  timestamp: string;
  provider?: string;
  model?: string;
  usage: Usage;
};

const UsageSchema = Type.Object({
  input: Type.Number({ minimum: 0 }),
  output: Type.Number({ minimum: 0 }),
  cacheRead: Type.Number({ minimum: 0 }),
  cacheWrite: Type.Number({ minimum: 0 }),
  totalTokens: Type.Number({ minimum: 0 }),
  cacheWrite1h: Type.Optional(Type.Number({ minimum: 0 })),
  reasoning: Type.Optional(Type.Number({ minimum: 0 })),
  cost: Type.Object({
    input: Type.Number({ minimum: 0 }),
    output: Type.Number({ minimum: 0 }),
    cacheRead: Type.Number({ minimum: 0 }),
    cacheWrite: Type.Number({ minimum: 0 }),
    total: Type.Number({ minimum: 0 }),
  }),
});

type Result = {
  name: string;
  task: string;
  model?: string;
  thinking?: ThinkingLevel;
  exitCode: number;
  stopReason?: string;
  error?: string;
  messages: Message[];
  usageEntries: UsageRecord[];
  usage: Usage & { turns: number };
};

type Details = { mode: Mode; results: Result[] };

function finalText(messages: Message[]): string {
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index];

    if (message.role !== "assistant") continue;

    return message.content
      .filter((part) => part.type === "text")
      .map((part) => part.text)
      .join("\n");
  }

  return "";
}

function failed(result: Result): boolean {
  return (
    result.exitCode !== 0 ||
    !!result.error ||
    result.stopReason === "error" ||
    result.stopReason === "aborted"
  );
}

function output(result: Result): string {
  return result.error || finalText(result.messages) || "(no output)";
}

function invocation(args: string[]) {
  const script = process.argv[1];

  if (script && !script.startsWith("/$bunfs/root/") && existsSync(script)) {
    return { command: process.execPath, args: [script, ...args] };
  }

  if (!/^(node|bun)(\.exe)?$/.test(basename(process.execPath).toLowerCase())) {
    return { command: process.execPath, args };
  }

  return { command: "pi", args };
}

function modelKey(model: { provider: string; id: string }): string {
  return `${model.provider}/${model.id}`;
}

function resolveAssignments(briefs: Brief[], ctx: ExtensionContext): Assignment[] {
  const listed = new Map(ctx.scopedModels.map((scoped) => [modelKey(scoped.model), scoped]));
  const errors: string[] = [];

  const assignments = briefs.map((brief) => {
    if (!brief.model) {
      return {
        model: ctx.model ? modelKey(ctx.model) : undefined,
        thinking: brief.thinking ?? ctx.thinkingLevel,
      };
    }

    if (listed.size && !listed.has(brief.model)) {
      errors.push(`${brief.name ?? "task"}: ${brief.model} is not in enabledModels`);
    }

    return {
      model: brief.model,
      thinking: brief.thinking ?? listed.get(brief.model)?.thinkingLevel,
    };
  });

  if (errors.length) {
    const allowed = [...listed.keys()].join(", ");

    throw new Error(`Cannot route subagents:\n- ${errors.join("\n- ")}\nAllowed: ${allowed}`);
  }

  return assignments;
}

function guidance(ctx: ExtensionContext): string | undefined {
  if (!ctx.scopedModels.length) return undefined;

  const models = ctx.scopedModels.map((scoped) => {
    const thinking = scoped.thinkingLevel ? ` @ ${scoped.thinkingLevel}` : "";

    return `${modelKey(scoped.model)}${thinking}`;
  });

  return `Subagent models: ${models.join(", ")}. Choose the model, reasoning level, and tools for each subagent task. For independent review, prefer a model family different from your own.`;
}

function run(
  brief: Brief,
  assignment: Assignment,
  cwd: string,
  signal: AbortSignal | undefined,
  update?: (result: Result) => void,
): Promise<Result> {
  const args = ["--mode", "json", "--print", "--no-session", "--exclude-tools", "subagent"];

  if (brief.tools) args.push("--tools", brief.tools.join(","));

  if (assignment.model) args.push("--model", assignment.model);

  if (assignment.thinking) args.push("--thinking", assignment.thinking);
  args.push(`Task: ${brief.task}`);

  const result: Result = {
    name: brief.name ?? "task",
    task: brief.task,
    model: assignment.model,
    thinking: assignment.thinking,
    exitCode: 1,
    messages: [],
    usageEntries: [],
    usage: { turns: 0, ...emptyUsage() },
  };

  if (signal?.aborted) {
    result.stopReason = "aborted";
    result.error = `Subagent ${result.name} was aborted`;

    return Promise.resolve(result);
  }

  return new Promise<Result>((resolve) => {
    const { command, args: childArgs } = invocation(args);

    let child: ChildProcessByStdio<null, Readable, Readable>;

    try {
      child = spawn(command, childArgs, {
        cwd: brief.cwd ?? cwd,
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (error) {
      result.error = error instanceof Error ? error.message : String(error);
      resolve(result);

      return;
    }

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    let buffer = "";
    let stderr = "";
    let aborted = false;
    let killTimer: ReturnType<typeof setTimeout> | undefined;

    const abort = () => {
      aborted = true;
      child.kill("SIGTERM");
      killTimer = setTimeout(() => child.kill("SIGKILL"), 5000);
    };

    signal?.addEventListener("abort", abort, { once: true });

    if (signal?.aborted) abort();

    let currentModel = assignment.model;
    const seenUsageEntries = new Set<string>();

    const line = (value: string) => {
      if (!value.trim()) return;

      let event: {
        type?: string;
        message?: Message;
        entry?: SessionEntry;
        result?: CompactionResult;
      };

      try {
        event = JSON.parse(value);
      } catch {
        return;
      }

      let record: UsageRecord | undefined;

      if (event.type === "entry_appended" && event.entry) {
        const entry = event.entry;

        if (
          entry.type === "usage" ||
          entry.type === "compaction" ||
          entry.type === "branch_summary"
        ) {
          if (!Value.Check(UsageSchema, entry.usage)) return;
          const identity = `${entry.id}/${entry.timestamp}`;

          if (seenUsageEntries.has(identity)) return;
          seenUsageEntries.add(identity);
          record = {
            type: entry.type,
            id: entry.id,
            timestamp: entry.timestamp,
            usage: entry.usage,
          };

          if (entry.type === "usage") {
            record.provider = entry.provider;
            record.model = entry.model;
          } else {
            // Summary events lack actual-model metadata; preserve the current-model inference.
            record.model = currentModel;
          }
        }
      } else if (event.type === "compaction_end" && Value.Check(UsageSchema, event.result?.usage)) {
        record = {
          type: "compaction",
          timestamp: new Date().toISOString(),
          model: currentModel,
          usage: event.result.usage,
        };
      }

      if (record) {
        result.usageEntries.push(record);
        addUsage(result.usage, record.usage);
        update?.(result);

        return;
      }

      if (event.type !== "message_end" || !event.message) return;
      result.messages.push(event.message);

      if (
        (event.message.role === "assistant" || event.message.role === "toolResult") &&
        event.message.usage
      ) {
        addUsage(result.usage, event.message.usage);
      }

      if (event.message.role === "assistant") {
        const message = event.message;
        result.usage.turns++;
        currentModel = `${message.provider}/${message.model}`;
        result.model ??= currentModel;
        result.stopReason = message.stopReason;
        result.error = message.errorMessage;
      }

      update?.(result);
    };

    child.stdout.on("data", (chunk: string) => {
      buffer += chunk;
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";

      for (const record of lines) line(record);
    });
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.on("error", (error) => {
      stderr += error.message;
    });
    child.on("close", (code) => {
      clearTimeout(killTimer);
      signal?.removeEventListener("abort", abort);

      if (buffer.trim()) line(buffer);

      result.exitCode = code ?? 1;

      if (aborted) {
        result.stopReason = "aborted";
        result.error = `Subagent ${result.name} was aborted`;
      }

      if (result.exitCode !== 0)
        result.error ??= stderr || `Subagent exited with code ${result.exitCode}`;

      if (!result.messages.some((message) => message.role === "assistant"))
        result.error ??= "Subagent produced no assistant response";
      resolve(result);
    });
  });
}

function emptyUsage(): Usage {
  return {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
}

function addUsage(total: Usage, usage: Usage): void {
  total.input += usage.input;
  total.output += usage.output;
  total.cacheRead += usage.cacheRead;
  total.cacheWrite += usage.cacheWrite;
  total.totalTokens += usage.totalTokens;
  total.cost.input += usage.cost.input;
  total.cost.output += usage.cost.output;
  total.cost.cacheRead += usage.cost.cacheRead;
  total.cost.cacheWrite += usage.cost.cacheWrite;
  total.cost.total += usage.cost.total;

  if (usage.cacheWrite1h !== undefined) {
    total.cacheWrite1h = (total.cacheWrite1h ?? 0) + usage.cacheWrite1h;
  }

  if (usage.reasoning !== undefined) {
    total.reasoning = (total.reasoning ?? 0) + usage.reasoning;
  }
}

function totalUsage(results: Result[]): Usage {
  const total = emptyUsage();

  for (const result of results) addUsage(total, result.usage);

  return total;
}

function capped(text: string): string {
  if (Buffer.byteLength(text) <= MAX_OUTPUT_BYTES) return text;
  const bytes = Buffer.from(text);

  return `${bytes.subarray(0, MAX_OUTPUT_BYTES).toString("utf8")}\n[Truncated; full output is in tool details.]`;
}

export default function subagent(pi: ExtensionAPI, agentDir = getAgentDir()) {
  let enabled = loadEnabled(agentDir);

  const deactivate = () => {
    const tools = pi.getActiveTools();

    if (tools.includes("subagent")) {
      pi.setActiveTools(tools.filter((name) => name !== "subagent"));
    }
  };

  pi.on("session_start", () => {
    if (!enabled) deactivate();
  });

  pi.registerCommand("subagents", {
    description: "Toggle subagents, or set on/off (saved across restarts)",
    handler: async (args, ctx) => {
      const action = args.trim().toLowerCase();

      if (action !== "" && action !== "on" && action !== "off") {
        ctx.ui.notify("Usage: /subagents [on|off]", "warning");

        return;
      }

      const next = action === "on" || (action === "" && !enabled);

      try {
        saveEnabled(agentDir, next);
      } catch (error) {
        ctx.ui.notify(`Could not save subagent setting: ${String(error)}`, "error");

        return;
      }

      enabled = next;

      if (enabled) {
        const tools = pi.getActiveTools();

        if (!tools.includes("subagent")) pi.setActiveTools([...tools, "subagent"]);
      } else {
        deactivate();
      }

      ctx.ui.notify(`Subagents ${enabled ? "enabled" : "disabled"}`, "info");
    },
  });

  pi.on("before_agent_start", (event, ctx) => {
    const sections = event.systemPromptOptions.sections;
    const text = enabled ? guidance(ctx) : undefined;

    if (!text || !event.systemPromptOptions.selectedTools?.includes("subagent")) {
      delete sections.subagent_models;

      return;
    }

    sections.subagent_models = text;
  });

  pi.registerTool({
    name: "subagent",
    label: "Subagent",
    defaultActive: enabled,
    description:
      "Run one self-contained task, independent parallel tasks, or a sequential chain in separate Pi processes. Each child has a fresh conversation but shares the filesystem. Omitted model and thinking inherit the parent's; omitted tools give Pi's defaults. A chain substitutes {previous} with the previous answer. Parallel writers need disjoint files.",
    parameters: Params,
    async execute(_id, params, signal, onUpdate, ctx) {
      if (!enabled) throw new Error("Subagents are disabled. Enable them with /subagents on.");

      const modes = [params.task, params.tasks, params.chain].filter(
        (value) => value !== undefined,
      );

      if (modes.length !== 1) throw new Error("Provide exactly one of task, tasks, or chain.");
      const mode: Mode = params.task ? "single" : params.tasks ? "parallel" : "chain";
      const briefs = params.task ? [params.task] : (params.tasks ?? params.chain ?? []);

      if (briefs.length === 0) throw new Error("Provide at least one task.");

      if (briefs.length > MAX_TASKS) throw new Error(`Maximum ${MAX_TASKS} tasks per call.`);
      const assignments = resolveAssignments(briefs, ctx);

      const roster = briefs.map((brief, index) => {
        const assignment = assignments[index];
        const reasoning = assignment.thinking ? ` @ ${assignment.thinking}` : "";

        return `${brief.name ?? index + 1}: ${assignment.model ?? "Pi default"}${reasoning}`;
      });

      onUpdate?.({
        content: [{ type: "text", text: `Routing subagents:\n${roster.join("\n")}` }],
        details: { mode, results: [] },
      });
      const results: Result[] = [];

      const publish = () =>
        onUpdate?.({
          content: [
            {
              type: "text",
              text: `${mode}: ${results.filter(Boolean).length}/${briefs.length} done`,
            },
          ],
          details: { mode, results: results.filter(Boolean) },
        });

      const runAt = async (index: number, brief: Brief): Promise<Result> => {
        const result = await run(brief, assignments[index], ctx.cwd, signal, (partial) => {
          results[index] = partial;
          onUpdate?.({
            content: [{ type: "text", text: `Running ${brief.name ?? index + 1}…` }],
            details: { mode, results: results.filter(Boolean) },
          });
        });

        results[index] = result;
        publish();

        return result;
      };

      if (mode === "chain") {
        let previous = "";

        for (const [index, brief] of briefs.entries()) {
          const result = await runAt(index, {
            ...brief,
            task: brief.task.replaceAll("{previous}", previous),
          });

          if (failed(result)) break;
          previous = finalText(result.messages);
        }
      } else if (mode === "single") {
        await runAt(0, briefs[0]);
      } else {
        let next = 0;
        await Promise.all(
          Array.from({ length: Math.min(MAX_CONCURRENT, briefs.length) }, async () => {
            while (next < briefs.length && !signal?.aborted) {
              const index = next++;
              await runAt(index, briefs[index]);
            }
          }),
        );
      }

      // Cancellation may leave unstarted parallel slots. Keep every completed
      // or interrupted child's accounting, and wait for all running children.
      const completed = results.filter(Boolean);
      const details: Details = { mode, results: completed };

      const usage = totalUsage(completed);

      if (mode !== "parallel") {
        const last = completed[completed.length - 1];
        let text = output(last);

        if (failed(last)) {
          let prefix = "Subagent failed";

          if (mode === "chain") prefix = `Chain stopped at step ${completed.length}`;

          text = `${prefix}: ${text}`;
        }

        return {
          content: [{ type: "text", text }],
          isError: failed(last),
          details,
          usage,
        };
      }

      const success = completed.filter((result) => !failed(result)).length;

      const summary = completed.map(
        (result, index) =>
          `### ${index + 1}. ${result.name} (${failed(result) ? "failed" : "completed"}; ${result.model ?? "unknown model"})\n${capped(output(result))}`,
      );

      return {
        content: [
          {
            type: "text",
            text: `${success}/${briefs.length} succeeded${signal?.aborted ? " (cancelled)" : ""}\n\n${summary.join("\n\n")}`,
          },
        ],
        isError: success === 0 || signal?.aborted === true,
        details,
        usage,
      };
    },
  });
}
