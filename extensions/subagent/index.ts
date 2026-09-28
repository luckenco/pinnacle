// Adapted from Pi's subagent example (v0.87.1). See README.md for source and license.
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { basename, join } from "node:path";
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import { getSupportedThinkingLevels, type Message } from "@earendil-works/pi-ai";
import {
  type ExtensionAPI,
  type ExtensionContext,
  getAgentDir,
} from "@earendil-works/pi-coding-agent";
import { type Static, Type } from "typebox";
import { loadConfig, missingAssignments } from "../subagent-models/config";

const READ_TOOLS = ["read", "grep", "find", "ls"];

const MAX_TASKS = 8;

const MAX_CONCURRENT = 4;

const MAX_OUTPUT_BYTES = 50 * 1024;

const Task = Type.Object({
  task: Type.String({
    description: "Self-contained brief: goal, scope, relevant paths, evidence, and output",
  }),
  name: Type.Optional(Type.String({ description: "Label used to identify this result" })),
  cwd: Type.Optional(
    Type.String({ description: "Working directory; use separate workspaces for parallel writers" }),
  ),
  model: Type.Optional(
    Type.String({
      description: "Exact Pi provider/model override; omit when using a configured role",
    }),
  ),
  role: Type.Optional(
    Type.Union([Type.Literal("eye"), Type.Literal("hand")], {
      description: "Use a configured eye or hand model and its reasoning level",
    }),
  ),
  eyeIndex: Type.Optional(
    Type.Integer({
      minimum: 1,
      description: "1-based configured eye to use; eye tasks without it consume eyes in pool order",
    }),
  ),
  tools: Type.Optional(
    Type.Array(Type.String(), {
      minItems: 1,
      description:
        "Explicit child tool allowlist; default read, grep, find, ls. Include bash/edit/write only when needed.",
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

type Assignment = {
  model?: string;
  thinking?: ThinkingLevel;
  source: "eye" | "hand" | "explicit" | "parent";
};

type Result = {
  name: string;
  task: string;
  model?: string;
  thinking?: ThinkingLevel;
  role?: "eye" | "hand";
  exitCode: number;
  stopReason?: string;
  error?: string;
  messages: Message[];
  usage: { turns: number; input: number; output: number; cost: number };
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

function resolveAssignments(
  briefs: Brief[],
  ctx: ExtensionContext,
  configPath: string,
): Assignment[] {
  for (const brief of briefs) {
    if (brief.model && brief.role) {
      throw new Error(`Task ${brief.name ?? "task"} cannot specify both model and role.`);
    }

    if (brief.eyeIndex !== undefined && brief.role !== "eye") {
      throw new Error(`Task ${brief.name ?? "task"} can only use eyeIndex with role "eye".`);
    }
  }

  const parentModel = ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined;

  if (!briefs.some((brief) => brief.role)) {
    return briefs.map((brief) => ({
      model: brief.model ?? parentModel,
      thinking: brief.model ? undefined : ctx.thinkingLevel,
      source: brief.model ? "explicit" : "parent",
    }));
  }

  const { config } = loadConfig(configPath);
  const missing = missingAssignments(config);

  if (missing.length) {
    throw new Error(
      `Subagent model roles are incomplete (${missing.join(", ")} missing). Run /subagent-models.`,
    );
  }

  const available = new Map(
    ctx.modelRegistry.getAvailable().map((model) => [`${model.provider}/${model.id}`, model]),
  );

  let nextEye = 0;
  const assignments: Assignment[] = [];
  const errors: string[] = [];

  for (const brief of briefs) {
    if (!brief.role) {
      assignments.push({
        model: brief.model ?? parentModel,
        thinking: brief.model ? undefined : ctx.thinkingLevel,
        source: brief.model ? "explicit" : "parent",
      });
      continue;
    }

    let eyeIndex = -1;

    if (brief.role === "eye") {
      eyeIndex = brief.eyeIndex === undefined ? nextEye++ : brief.eyeIndex - 1;
    }

    const modelId = brief.role === "hand" ? config.hand : config.eye[eyeIndex];

    const thinking =
      brief.role === "hand" ? config.reasoning.hand : config.reasoning.eye[modelId ?? ""];

    const label = brief.name ?? "task";

    if (!modelId || thinking === null || thinking === undefined) {
      errors.push(
        brief.role === "eye"
          ? `${label}: no configured eye ${eyeIndex + 1}; choose an explicit available model for this overflow seat`
          : `${label}: hand is not configured`,
      );
      continue;
    }

    const model = available.get(modelId);

    if (!model) {
      errors.push(`${label}: configured ${brief.role} ${modelId} is unavailable`);
      continue;
    }

    if (!getSupportedThinkingLevels(model).includes(thinking)) {
      errors.push(`${label}: ${modelId} does not support saved reasoning level ${thinking}`);
      continue;
    }

    assignments.push({ model: modelId, thinking, source: brief.role });
  }

  if (errors.length) throw new Error(`Cannot route subagents:\n- ${errors.join("\n- ")}`);

  return assignments;
}

function run(
  brief: Brief,
  assignment: Assignment,
  cwd: string,
  signal: AbortSignal | undefined,
  update?: (result: Result) => void,
): Promise<Result> {
  signal?.throwIfAborted();

  const args = [
    "--mode",
    "json",
    "--print",
    "--no-session",
    "--exclude-tools",
    "subagent",
    "--tools",
    (brief.tools ?? READ_TOOLS).join(","),
  ];

  if (assignment.model) args.push("--model", assignment.model);

  if (assignment.thinking) args.push("--thinking", assignment.thinking);
  args.push(`Task: ${brief.task}`);

  const result: Result = {
    name: brief.name ?? "task",
    task: brief.task,
    model: assignment.model,
    thinking: assignment.thinking,
    role: brief.role,
    exitCode: 1,
    messages: [],
    usage: { turns: 0, input: 0, output: 0, cost: 0 },
  };

  return new Promise<Result>((resolve, reject) => {
    const { command, args: childArgs } = invocation(args);

    const child = spawn(command, childArgs, {
      cwd: brief.cwd ?? cwd,
      stdio: ["ignore", "pipe", "pipe"],
    });

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

    const line = (value: string) => {
      if (!value.trim()) return;
      let event: { type?: string; message?: Message };

      try {
        event = JSON.parse(value);
      } catch {
        return;
      }

      if (event.type !== "message_end" || !event.message) return;
      result.messages.push(event.message);

      if (event.message.role === "assistant") {
        const message = event.message;
        result.usage.turns++;
        result.usage.input += message.usage.input;
        result.usage.output += message.usage.output;
        result.usage.cost += message.usage.cost.total;
        result.model ??= `${message.provider}/${message.model}`;
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

      if (aborted) {
        reject(new Error(`Subagent ${result.name} was aborted`));

        return;
      }

      result.exitCode = code ?? 1;

      if (result.exitCode !== 0)
        result.error ??= stderr || `Subagent exited with code ${result.exitCode}`;

      if (!result.messages.some((message) => message.role === "assistant"))
        result.error ??= "Subagent produced no assistant response";
      resolve(result);
    });
  });
}

function capped(text: string): string {
  if (Buffer.byteLength(text) <= MAX_OUTPUT_BYTES) return text;
  const bytes = Buffer.from(text);

  return `${bytes.subarray(0, MAX_OUTPUT_BYTES).toString("utf8")}\n[Truncated; full output is in tool details.]`;
}

export default function subagent(
  pi: ExtensionAPI,
  configPath = join(getAgentDir(), "extensions", "subagent-models.json"),
) {
  pi.registerTool({
    name: "subagent",
    label: "Subagent",
    description:
      "Run one self-contained task, independent parallel tasks, or a sequential chain in separate Pi processes. The child has a fresh conversation, not a separate filesystem. Default tools are read-only (read, grep, find, ls); set tools explicitly to allow writing, Bash, or MCP. Use role eye/hand for configured models and reasoning, or model for an exact override. Implicit eye tasks consume the ordered pool; overflow seats need an explicit model. A chain substitutes {previous} with the previous answer. Give parallel writers separate working directories.",
    parameters: Params,
    async execute(_id, params, signal, onUpdate, ctx) {
      const modes = [params.task, params.tasks, params.chain].filter(
        (value) => value !== undefined,
      );

      if (modes.length !== 1) throw new Error("Provide exactly one of task, tasks, or chain.");
      const mode: Mode = params.task ? "single" : params.tasks ? "parallel" : "chain";
      const briefs = params.task ? [params.task] : (params.tasks ?? params.chain ?? []);

      if (briefs.length === 0) throw new Error("Provide at least one task.");

      if (briefs.length > MAX_TASKS) throw new Error(`Maximum ${MAX_TASKS} tasks per call.`);
      const assignments = resolveAssignments(briefs, ctx, configPath);

      const roster = briefs.map((brief, index) => {
        const assignment = assignments[index];
        const reasoning = assignment.thinking ? ` @ ${assignment.thinking}` : "";

        return `${brief.name ?? index + 1}: ${assignment.model ?? "Pi default"}${reasoning} (${assignment.source})`;
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

          if (failed(result))
            throw new Error(`Chain stopped at step ${index + 1}: ${output(result)}`);
          previous = finalText(result.messages);
        }
      } else if (mode === "single") {
        const result = await runAt(0, briefs[0]);

        if (failed(result)) throw new Error(`Subagent failed: ${output(result)}`);
      } else {
        let next = 0;
        await Promise.all(
          Array.from({ length: Math.min(MAX_CONCURRENT, briefs.length) }, async () => {
            while (next < briefs.length) {
              const index = next++;
              await runAt(index, briefs[index]);
            }
          }),
        );
      }

      const details: Details = { mode, results };

      if (mode !== "parallel")
        return { content: [{ type: "text", text: output(results[results.length - 1]) }], details };
      const success = results.filter((result) => !failed(result)).length;

      const summary = results.map(
        (result, index) =>
          `### ${index + 1}. ${result.name} (${failed(result) ? "failed" : "completed"}; ${result.model ?? "unknown model"})\n${capped(output(result))}`,
      );

      return {
        content: [
          {
            type: "text",
            text: `${success}/${results.length} succeeded\n\n${summary.join("\n\n")}`,
          },
        ],
        details,
      };
    },
  });
}
