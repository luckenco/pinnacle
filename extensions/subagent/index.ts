// Adapted from Pi's subagent example (v0.87.1). See README.md for source and license.
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { basename } from "node:path";
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { Message } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { type Static, Type } from "typebox";

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
    Type.String({ description: "Pi provider/model ID; defaults to the parent model" }),
  ),
  tools: Type.Optional(
    Type.Array(Type.String(), {
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
type Result = {
  name: string;
  task: string;
  model?: string;
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
  return result.exitCode !== 0 || result.stopReason === "error" || result.stopReason === "aborted";
}

function output(result: Result): string {
  return result.error || finalText(result.messages) || "(no output)";
}

function invocation(args: string[]): { command: string; args: string[] } {
  const script = process.argv[1];
  if (script && !script.startsWith("/$bunfs/root/") && existsSync(script)) {
    return { command: process.execPath, args: [script, ...args] };
  }
  if (!/^(node|bun)(\.exe)?$/.test(basename(process.execPath).toLowerCase())) {
    return { command: process.execPath, args };
  }
  return { command: "pi", args };
}

function run(
  brief: Brief,
  cwd: string,
  parentModel: string | undefined,
  thinking: ThinkingLevel | undefined,
  signal: AbortSignal | undefined,
  update?: (result: Result) => void,
): Promise<Result> {
  signal?.throwIfAborted();
  const model = brief.model ?? parentModel;
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
  if (model) args.push("--model", model);
  if (!brief.model && thinking) args.push("--thinking", thinking);
  args.push(`Task: ${brief.task}`);
  const result: Result = {
    name: brief.name ?? "task",
    task: brief.task,
    model,
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
      resolve(result);
    });
  });
}

function capped(text: string): string {
  if (Buffer.byteLength(text) <= MAX_OUTPUT_BYTES) return text;
  const bytes = Buffer.from(text);
  return `${bytes.subarray(0, MAX_OUTPUT_BYTES).toString("utf8")}\n[Truncated; full output is in tool details.]`;
}

export default function subagent(pi: ExtensionAPI) {
  pi.registerTool({
    name: "subagent",
    label: "Subagent",
    description:
      "Run one self-contained task, independent parallel tasks, or a sequential chain in separate Pi processes. The child has a fresh conversation, not a separate filesystem. Default tools are read-only (read, grep, find, ls); set tools explicitly to allow writing, Bash, or MCP. Specify model per task to use different models. A chain substitutes {previous} with the previous answer. Give parallel writers separate working directories.",
    parameters: Params,
    async execute(_id, params, signal, onUpdate, ctx) {
      const modes = [params.task, params.tasks?.length, params.chain?.length].filter(Boolean);
      if (modes.length !== 1) throw new Error("Provide exactly one of task, tasks, or chain.");
      const mode: Mode = params.task ? "single" : params.tasks ? "parallel" : "chain";
      const briefs = params.task ? [params.task] : (params.tasks ?? params.chain ?? []);
      if (briefs.length > MAX_TASKS) throw new Error(`Maximum ${MAX_TASKS} tasks per call.`);
      const parentModel = ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined;
      const results: Result[] = new Array(briefs.length);
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
        const result = await run(
          brief,
          ctx.cwd,
          parentModel,
          ctx.thinkingLevel,
          signal,
          (partial) => {
            results[index] = partial;
            onUpdate?.({
              content: [{ type: "text", text: `Running ${brief.name ?? index + 1}…` }],
              details: { mode, results: results.filter(Boolean) },
            });
          },
        );
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
