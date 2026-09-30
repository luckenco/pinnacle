import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
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
import { addSessionToRange, buildRangeAgg, parseSessionFile } from "../../session-breakdown";
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
      usageEntries: Type.Array(
        Type.Object({
          type: Type.String(),
          timestamp: Type.String(),
          provider: Type.Optional(Type.String()),
          model: Type.Optional(Type.String()),
          usage: Type.Object({ totalTokens: Type.Number() }),
        }),
      ),
      usage: Type.Object({
        turns: Type.Number(),
        totalTokens: Type.Number(),
        cost: Type.Object({ total: Type.Number() }),
      }),
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
  assert.equal(child.args[child.args.indexOf("--tools") + 1], "read,grep,find,ls,codemode");
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

test("child non-message usage is retained on success and failure without double-counting", async () => {
  for (const task of ["usage events", "usage events fail"]) {
    const result = await tool.execute("usage", { task: { task } }, undefined, undefined, ctx);
    assert.equal(result.isError, task === "usage events fail");
    assert.equal(result.usage?.totalTokens, 90);
    assert.ok(Math.abs((result.usage?.cost.total ?? 0) - 0.09) < 1e-12);
    assert.equal(result.usage?.cacheRead, 43);
    assert.equal(result.usage?.cacheWrite, 24);
    assert.equal(result.usage?.cacheWrite1h, 20);
    assert.equal(result.usage?.reasoning, 9);
    assert.ok(Value.Check(resultSchema, result.details));
    const child = result.details.results[0];
    assert.equal(child.messages.length, 1);
    assert.equal(child.usage.turns, 1);
    assert.equal(child.usage.totalTokens, 90);
    assert.equal(child.usageEntries.length, 4);
    assert.equal(child.usageEntries[0].provider, "test");
    assert.equal(child.usageEntries[0].model, "cache");
    assert.equal(child.usageEntries[1].model, "test/fixture");

    // The parent's stored result feeds the same reporter as ordinary sessions.
    const file = join(root, `${task}.jsonl`);
    const timestamp = new Date().toISOString();
    writeFileSync(
      file,
      [
        { type: "session", timestamp },
        {
          type: "message",
          timestamp,
          message: { role: "toolResult", toolName: "subagent", ...result },
        },
      ]
        .map((entry) => JSON.stringify(entry))
        .join("\n"),
    );
    const session = await parseSessionFile(file);
    assert.ok(session);
    assert.equal(session.tokens, 90);
    assert.equal(session.messages, 2);
    assert.ok(Math.abs(session.totalCost - 0.09) < 1e-12);
    assert.equal(session.costByModel.get("test/cache"), 0.02);
    assert.ok(Math.abs((session.costByModel.get("test/fixture") ?? 0) - 0.07) < 1e-12);
    assert.equal(session.costByModel.has("subagent/unknown"), false);
    const range = buildRangeAgg(1, new Date(child.usageEntries[0].timestamp));
    addSessionToRange(range, session);
    assert.equal(range.totalTokens, 60);
    assert.equal(range.totalMessages, 0);
  }
});

test("non-message spend survives failure before any assistant response", async () => {
  const result = await tool.execute(
    "usage-only",
    { task: { task: "usage only fail" } },
    undefined,
    undefined,
    ctx,
  );

  assert.equal(result.isError, true);
  assert.match(text(result), /no assistant response/);
  assert.equal(result.usage?.totalTokens, 80);
  assert.ok(Math.abs((result.usage?.cost.total ?? 0) - 0.08) < 1e-12);
  assert.ok(Value.Check(resultSchema, result.details));
  const child = result.details.results[0];
  assert.equal(child.messages.length, 0);
  assert.equal(child.usageEntries.length, 4);
  assert.equal(child.usage.turns, 0);
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

    let tools = "read,grep,find,ls,codemode";

    if (index === 0) tools += ",bash,edit,write";
    assert.equal(args[args.indexOf("--tools") + 1], tools);
    assert.equal(args[args.indexOf("--exclude-tools") + 1], "subagent");
  }

  assert.match(updates[0], /first eye: test\/eye-a @ high \(eye\)/);
  assert.match(updates[0], /overflow: test\/overflow \(explicit\)/);
});

test("explicit hand tools replace write-capable defaults without adding codemode", async () => {
  saveModels();

  const result = await tool.execute(
    "read-only-hand",
    { task: { task: "inspect", role: "hand", tools: ["read"] } },
    undefined,
    undefined,
    ctx,
  );

  const args = childArgs(result);
  assert.equal(args[args.indexOf("--tools") + 1], "read");
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
        { name: "second", task: "paid fail" },
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
  assert.match(text(result), /fixture paid failure/);
  assert.match(text(result), /Subagent produced no assistant response/);
  assert.equal(result.isError, false);
  assert.equal(result.usage?.cost.total, 0.02);
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

  const stopped = await tool.execute(
    "chain-fail",
    { chain: [{ task: "inspect" }, { task: "paid fail" }, { task: "must not run" }] },
    undefined,
    undefined,
    ctx,
  );

  assert.equal(stopped.isError, true);
  assert.match(text(stopped), /Chain stopped at step 2.*fixture paid failure/);
  assert.ok(Value.Check(resultSchema, stopped.details));
  assert.equal(stopped.details.results.length, 2);
  assert.equal(stopped.usage?.totalTokens, 20);
  assert.equal(stopped.usage?.cost.total, 0.02);
});

test("single failures preserve usage and details, including assistant errors and empty responses", async () => {
  for (const task of ["paid fail", "assistant error", "fail", "empty"]) {
    const result = await tool.execute("single-fail", { task: { task } }, undefined, undefined, ctx);
    const paid = task === "paid fail" || task === "assistant error";
    assert.equal(result.isError, true);
    assert.match(text(result), /Subagent failed:/);
    assert.ok(Value.Check(resultSchema, result.details));
    assert.equal(result.details.results.length, 1);
    assert.equal(result.details.results[0].messages.length, paid ? 1 : 0);
    assert.equal(result.usage?.totalTokens, paid ? 10 : 0);
    assert.equal(result.usage?.cost.total, paid ? 0.01 : 0);
  }
});

test("failed child accounting survives session serialization and breakdown", async () => {
  const result = await tool.execute(
    "paid",
    { task: { task: "paid fail" } },
    undefined,
    undefined,
    ctx,
  );

  assert.equal(result.isError, true);
  const file = join(root, "failed-session.jsonl");
  const timestamp = new Date().toISOString();
  writeFileSync(
    file,
    [
      { type: "session", timestamp },
      {
        type: "message",
        timestamp,
        message: {
          role: "toolResult",
          toolName: "subagent",
          ...result,
        },
      },
    ]
      .map((entry) => JSON.stringify(entry))
      .join("\n"),
  );
  const session = await parseSessionFile(file);
  assert.ok(session);
  assert.equal(session.totalCost, 0.01);
  assert.equal(session.tokens, 10);
  assert.equal(session.costByModel.get("test/fixture"), 0.01);
});

test("launch errors preserve prior and parallel child accounting", async () => {
  const invalid = { task: "invalid cwd", cwd: "bad\u0000cwd" };

  const chain = await tool.execute(
    "launch-chain",
    { chain: [{ task: "inspect" }, invalid] },
    undefined,
    undefined,
    ctx,
  );

  assert.equal(chain.isError, true);
  assert.match(text(chain), /Chain stopped at step 2/);
  assert.equal(chain.usage?.cost.total, 0.01);
  assert.ok(Value.Check(resultSchema, chain.details));
  assert.equal(chain.details.results.length, 2);

  const parallel = await tool.execute(
    "launch-parallel",
    { tasks: [invalid, { task: "inspect" }] },
    undefined,
    undefined,
    ctx,
  );

  assert.match(text(parallel), /1\/2 succeeded/);
  assert.equal(parallel.usage?.cost.total, 0.01);
  assert.ok(Value.Check(resultSchema, parallel.details));
  assert.equal(parallel.details.results.length, 2);
});

test("pre-aborted calls report cancellation without launching children", async () => {
  const signal = AbortSignal.abort();

  for (const params of [{ task: { task: "inspect" } }, { tasks: [{ task: "inspect" }] }]) {
    const result = await tool.execute("pre-aborted", params, signal, undefined, ctx);
    assert.equal(result.isError, true);
    assert.equal(result.usage?.cost.total, 0);
    assert.ok(Value.Check(resultSchema, result.details));
    assert.ok(result.details.results.every((child) => child.messages.length === 0));
  }
});

test(
  "parallel cancellation drains running children and never launches queued tasks",
  { timeout: 12000 },
  async () => {
    const controller = new AbortController();

    const result = await tool.execute(
      "abort-parallel",
      { tasks: [...Array.from({ length: 4 }, () => ({ task: "hang" })), { task: "must not run" }] },
      controller.signal,
      (update) => {
        if (!Value.Check(resultSchema, update.details)) return;

        if (
          update.details.results.length === 4 &&
          update.details.results.every((child) => child.usage.turns === 1)
        )
          controller.abort();
      },
      ctx,
    );

    assert.equal(result.isError, true);
    assert.match(text(result), /0\/5 succeeded \(cancelled\)/);
    assert.equal(result.usage?.cost.total, 0.04);
    assert.equal(result.usage?.totalTokens, 40);
    assert.ok(Value.Check(resultSchema, result.details));
    assert.equal(result.details.results.length, 4);
  },
);

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

test(
  "chain cancellation kills the child and preserves completed step usage",
  { timeout: 12000 },
  async () => {
    const controller = new AbortController();
    let pid: number | undefined;

    try {
      const result = await tool.execute(
        "abort",
        { chain: [{ task: "inspect" }, { task: "hang" }, { task: "must not run" }] },
        controller.signal,
        (update) => {
          if (!Value.Check(resultSchema, update.details)) return;

          if (update.details.results.length !== 2) return;
          const message = update.details.results[1].messages.at(-1);

          if (pid || !Value.Check(assistantSchema, message)) return;

          const part = message.content.find((part) => part.text.startsWith("{"));

          if (!part) return;
          const payload: unknown = JSON.parse(part.text);

          if (!Value.Check(Type.Object({ pid: Type.Number() }), payload)) return;
          pid = payload.pid;
          controller.abort();
        },
        ctx,
      );

      assert.equal(result.isError, true);
      assert.match(text(result), /was aborted/);
      assert.equal(result.usage?.totalTokens, 20);
      assert.equal(result.usage?.cost.total, 0.02);
      assert.ok(Value.Check(resultSchema, result.details));
      assert.equal(result.details.results.length, 2);
      assert.equal(result.details.results[1].messages.length, 1);
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
  },
);
