import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import { fileURLToPath } from "node:url";
import type { Api, Model } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { Value } from "typebox/value";
import type {
  ExtensionAPI,
  ExtensionToolContext,
  ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { type SubagentModels, saveConfig } from "../../subagent-models/config";
import subagent from "../index";

let root: string;

let tool: Pick<ToolDefinition, "execute">;

let ctx: ExtensionToolContext;

let configPath: string;

let previousScript: string;

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "pinnacle-subagent-")));
  previousScript = process.argv[1];
  process.argv[1] = fileURLToPath(new URL("./fixtures/child.mjs", import.meta.url));
  configPath = join(root, "subagent-models.json");

  const models: Model<Api>[] = [
    { id: "eye-a", reasoning: true },
    { id: "eye-b", reasoning: false },
    { id: "hand", reasoning: true },
    { id: "overflow", reasoning: true },
  ].map((fields) => ({
    api: "openai-completions",
    provider: "test",
    name: fields.id,
    baseUrl: "https://example.invalid",
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 1000,
    maxTokens: 100,
    ...fields,
  }));

  // SAFETY: this fixture is only passed to the registered tool, which reads these context fields.
  ctx = {
    cwd: root,
    model: { provider: "test", id: "parent" },
    modelRegistry: { getAvailable: () => models },
    thinkingLevel: "high",
  } as ExtensionToolContext;
  // SAFETY: registration only calls registerTool; no other ExtensionAPI method is used.
  subagent(
    {
      registerTool: (definition) => {
        tool = definition;
      },
    } as ExtensionAPI,
    configPath,
  );
});

afterEach(() => {
  process.argv[1] = previousScript;
  rmSync(root, { recursive: true, force: true });
});

function text(result: Awaited<ReturnType<ToolDefinition["execute"]>>) {
  const part = result.content[0];
  assert.equal(part.type, "text");

  return part.text;
}

const resultSchema = Type.Object({
  results: Type.Array(
    Type.Object({
      messages: Type.Array(Type.Unknown()),
      usage: Type.Object({ turns: Type.Number() }),
    }),
  ),
});

const assistantSchema = Type.Object({
  role: Type.Literal("assistant"),
  content: Type.Array(Type.Object({ type: Type.Literal("text"), text: Type.String() })),
});

const childSchema = Type.Object({ args: Type.Array(Type.String()) });

function childArgs(result: Awaited<ReturnType<ToolDefinition["execute"]>>, index = 0): string[] {
  const details = result.details;
  assert.ok(Value.Check(resultSchema, details));
  const messages = details.results[index].messages;
  let message: unknown;

  for (let index = messages.length - 1; index >= 0; index--) {
    if (Value.Check(assistantSchema, messages[index])) {
      message = messages[index];
      break;
    }
  }

  assert.ok(Value.Check(assistantSchema, message));
  const part = message.content.find((item) => item.type === "text" && item.text.startsWith("{"));
  assert.ok(part);
  const payload: unknown = JSON.parse(part.text);
  assert.ok(Value.Check(childSchema, payload));

  return payload.args;
}

function saveModels(overrides: Partial<SubagentModels> = {}): void {
  const config: SubagentModels = {
    eye: ["test/eye-a", "test/eye-b"],
    hand: "test/hand",
    reasoning: { eye: { "test/eye-a": "high", "test/eye-b": "off" }, hand: "low" },
    ...overrides,
  };

  saveConfig(configPath, null, config);
}

test("a task inherits the parent's model/thinking and defaults to read-only tools", async () => {
  const cwd = join(root, "workspace");
  mkdirSync(cwd);

  const result = await tool.execute(
    "single",
    { task: { task: "inspect", cwd } },
    undefined,
    undefined,
    ctx,
  );

  const child = JSON.parse(text(result).split("\n")[1]);
  assert.equal(child.cwd, cwd);
  assert.equal(child.args[child.args.indexOf("--model") + 1], "test/parent");
  assert.equal(child.args[child.args.indexOf("--thinking") + 1], "high");
  assert.equal(child.args[child.args.indexOf("--tools") + 1], "read,grep,find,ls");
  assert.equal(child.args[child.args.indexOf("--exclude-tools") + 1], "subagent");
  assert.match(text(result), /^inspect ✓\n/);
  assert.ok(Value.Check(resultSchema, result.details));
  assert.equal(result.details.results[0].usage.turns, 1);
  assert.deepEqual(result.usage, {
    input: 1,
    output: 2,
    cacheRead: 3,
    cacheWrite: 4,
    reasoning: 1,
    totalTokens: 10,
    cost: {
      input: 0.001,
      output: 0.002,
      cacheRead: 0.003,
      cacheWrite: 0.004,
      total: 0.01,
    },
  });
});

test("tool-reported child usage is included in the parent total", async () => {
  const result = await tool.execute(
    "nested-usage",
    { task: { task: "tool usage" } },
    undefined,
    undefined,
    ctx,
  );

  assert.equal(result.usage?.totalTokens, 30);
  assert.equal(result.usage?.cost.total, 0.03);
  assert.equal(result.usage?.cacheRead, 18);
});

test("per-task model, tool permissions, and workspace override the defaults", async () => {
  const result = await tool.execute(
    "single",
    {
      task: {
        name: "writer",
        task: "inspect",
        model: "test/override",
        tools: ["read", "bash", "edit", "write"],
        cwd: root,
      },
    },
    undefined,
    undefined,
    ctx,
  );

  const args: string[] = JSON.parse(text(result).split("\n")[1]).args;
  assert.equal(args[args.indexOf("--model") + 1], "test/override");
  assert.equal(args[args.indexOf("--tools") + 1], "read,bash,edit,write");
  assert.equal(args.includes("--thinking"), false);
});

test("configured roles apply eye order, the hand, and saved reasoning", async () => {
  saveModels();
  const updates: string[] = [];

  const result = await tool.execute(
    "roles",
    {
      tasks: [
        { name: "hand", task: "inspect", role: "hand" },
        { name: "first eye", task: "inspect", role: "eye" },
        { name: "overflow", task: "inspect", model: "test/overflow" },
        { name: "second eye", task: "inspect", role: "eye" },
      ],
    },
    undefined,
    (update) => {
      const part = update.content[0];

      if (part.type === "text") updates.push(part.text);
    },
    ctx,
  );

  const expected = [
    ["test/hand", "low"],
    ["test/eye-a", "high"],
    ["test/overflow", undefined],
    ["test/eye-b", "off"],
  ];

  for (const [index, [model, thinking]] of expected.entries()) {
    const args = childArgs(result, index);
    assert.equal(args[args.indexOf("--model") + 1], model);
    assert.equal(args.includes("--thinking"), thinking !== undefined);

    if (thinking !== undefined) assert.equal(args[args.indexOf("--thinking") + 1], thinking);
  }

  assert.match(updates[0], /first eye: test\/eye-a @ high \(eye\)/);
  assert.match(updates[0], /overflow: test\/overflow \(explicit\)/);
});

test("an eye can be selected by index without changing explicit model behavior", async () => {
  saveModels();

  const selected = await tool.execute(
    "selected-eye",
    { task: { task: "inspect", role: "eye", eyeIndex: 2 } },
    undefined,
    undefined,
    ctx,
  );

  const selectedArgs = childArgs(selected);
  assert.equal(selectedArgs[selectedArgs.indexOf("--model") + 1], "test/eye-b");
  assert.equal(selectedArgs[selectedArgs.indexOf("--thinking") + 1], "off");

  await assert.rejects(
    tool.execute(
      "conflict",
      { task: { task: "inspect", role: "eye", model: "test/overflow" } },
      undefined,
      undefined,
      ctx,
    ),
    /cannot specify both model and role/,
  );
});

test("role routing rejects incomplete, overflow, unavailable, and unsupported assignments", async () => {
  await assert.rejects(
    tool.execute("missing", { task: { task: "inspect", role: "eye" } }, undefined, undefined, ctx),
    /eye, hand missing/,
  );

  saveModels();
  await assert.rejects(
    tool.execute(
      "overflow",
      {
        tasks: [
          { task: "inspect", role: "eye" },
          { task: "inspect", role: "eye" },
          { name: "third", task: "inspect", role: "eye" },
        ],
      },
      undefined,
      undefined,
      ctx,
    ),
    /third: no configured eye 3.*explicit available model/,
  );

  rmSync(configPath);
  saveModels({
    hand: "test/unavailable",
    reasoning: { eye: { "test/eye-a": "high", "test/eye-b": "off" }, hand: "low" },
  });
  await assert.rejects(
    tool.execute(
      "unavailable",
      { task: { task: "inspect", role: "hand" } },
      undefined,
      undefined,
      ctx,
    ),
    /configured hand test\/unavailable is unavailable/,
  );

  rmSync(configPath);
  saveModels({ reasoning: { eye: { "test/eye-a": "high", "test/eye-b": "high" }, hand: "low" } });
  await assert.rejects(
    tool.execute(
      "unsupported",
      { task: { task: "inspect", role: "eye", eyeIndex: 2 } },
      undefined,
      undefined,
      ctx,
    ),
    /does not support saved reasoning level high/,
  );
});

test("parallel returns successful results and failed child diagnostics separately", async () => {
  const result = await tool.execute(
    "parallel",
    {
      tasks: [
        { name: "first", task: "inspect" },
        { name: "second", task: "fail" },
        { name: "empty", task: "empty" },
      ],
    },
    undefined,
    undefined,
    ctx,
  );

  assert.match(text(result), /1\/3 succeeded/);
  assert.match(text(result), /inspect ✓/);
  assert.match(text(result), /second \(failed/);
  assert.match(text(result), /fixture failure/);
  assert.match(text(result), /Subagent produced no assistant response/);
});

test("chains substitute previous output and stop at a failed child", async () => {
  const result = await tool.execute(
    "chain",
    { chain: [{ task: "first" }, { task: "after {previous}" }] },
    undefined,
    undefined,
    ctx,
  );

  assert.match(text(result), /after first ✓/);
  await assert.rejects(
    tool.execute(
      "chain-fail",
      { chain: [{ task: "fail" }, { task: "must not run" }] },
      undefined,
      undefined,
      ctx,
    ),
    /Chain stopped at step 1.*fixture failure/,
  );
  await assert.rejects(
    tool.execute("single-fail", { task: { task: "fail" } }, undefined, undefined, ctx),
    /fixture failure/,
  );
});

test("invalid modes and oversized batches fail without running children", async () => {
  await assert.rejects(tool.execute("invalid", {}, undefined, undefined, ctx), /exactly one/);
  await assert.rejects(
    tool.execute("empty", { tasks: [] }, undefined, undefined, ctx),
    /at least one/,
  );
  await assert.rejects(
    tool.execute("mixed", { tasks: [], chain: [{ task: "inspect" }] }, undefined, undefined, ctx),
    /exactly one/,
  );
  await assert.rejects(
    tool.execute(
      "oversized",
      { tasks: Array.from({ length: 9 }, () => ({ task: "inspect" })) },
      undefined,
      undefined,
      ctx,
    ),
    /Maximum 8/,
  );
});

test("cancellation kills a child ignoring SIGTERM", { timeout: 12000 }, async () => {
  const controller = new AbortController();
  let pid: number | undefined;

  try {
    await assert.rejects(
      tool.execute(
        "abort",
        { task: { task: "hang" } },
        controller.signal,
        (update) => {
          if (!Value.Check(resultSchema, update.details)) return;
          const message = update.details.results[0]?.messages.at(-1);

          if (pid || !Value.Check(assistantSchema, message)) return;

          const part = message.content.find((part) => part.text.startsWith("{"));

          if (!part) return;
          const payload: unknown = JSON.parse(part.text);

          if (!Value.Check(Type.Object({ pid: Type.Number() }), payload)) return;
          pid = payload.pid;
          controller.abort();
        },
        ctx,
      ),
      /was aborted/,
    );
    assert.ok(pid);
    const childPid = pid;
    assert.throws(() => process.kill(childPid, 0));
  } finally {
    if (pid) {
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        /* already exited */
      }
    }
  }
});
