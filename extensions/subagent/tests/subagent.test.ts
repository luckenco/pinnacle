import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import { fileURLToPath } from "node:url";
import type { Api, Message, Model } from "@earendil-works/pi-ai";
import type {
  ExtensionAPI,
  ExtensionContext,
  ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { type SubagentModels, saveConfig } from "../../subagent-models/config";
import subagent from "../index";

let root: string;
let tool: Pick<ToolDefinition, "execute">;
let ctx: ExtensionContext;
let configPath: string;
let previousScript: string;

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "pinnacle-subagent-")));
  previousScript = process.argv[1];
  process.argv[1] = fileURLToPath(new URL("./fixtures/child.mjs", import.meta.url));
  configPath = join(root, "subagent-models.json");
  const models = [
    { provider: "test", id: "eye-a", reasoning: true },
    { provider: "test", id: "eye-b", reasoning: false },
    { provider: "test", id: "hand", reasoning: true },
    { provider: "test", id: "overflow", reasoning: true },
  ] as Model<Api>[];
  ctx = {
    cwd: root,
    model: { provider: "test", id: "parent" },
    modelRegistry: { getAvailable: () => models },
    thinkingLevel: "high",
  } as ExtensionContext;
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

function childArgs(result: Awaited<ReturnType<ToolDefinition["execute"]>>, index = 0): string[] {
  const messages = (result.details as { results: Array<{ messages: Message[] }> }).results[index]
    .messages;
  let message: Message | undefined;
  for (let cursor = messages.length - 1; cursor >= 0; cursor--) {
    if (messages[cursor].role === "assistant") {
      message = messages[cursor];
      break;
    }
  }
  assert.ok(message && message.role === "assistant");
  const part = message.content.find((item) => item.type === "text" && item.text.startsWith("{"));
  assert.ok(part && part.type === "text");
  return JSON.parse(part.text).args;
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
  assert.equal(
    (result.details as { results: Array<{ usage: { turns: number } }> }).results[0].usage.turns,
    1,
  );
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
          const details = (update.details as { results: Array<{ messages: Message[] }> })
            .results[0];
          const message = details?.messages?.at(-1);
          if (pid || message?.role !== "assistant") return;
          const part = message.content.find(
            (part) => part.type === "text" && part.text.startsWith("{"),
          );
          if (part?.type !== "text") return;
          pid = JSON.parse(part.text).pid;
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
