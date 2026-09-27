import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import { fileURLToPath } from "node:url";
import type { Message } from "@earendil-works/pi-ai";
import type {
  ExtensionAPI,
  ExtensionContext,
  ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import subagent from "../index";

let root: string;
let tool: Pick<ToolDefinition, "execute">;
let ctx: ExtensionContext;
let previousScript: string;

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "pinnacle-subagent-")));
  previousScript = process.argv[1];
  process.argv[1] = fileURLToPath(new URL("./fixtures/child.mjs", import.meta.url));
  ctx = {
    cwd: root,
    model: { provider: "test", id: "parent" },
    thinkingLevel: "high",
  } as ExtensionContext;
  subagent({
    registerTool: (definition) => {
      tool = definition;
    },
  } as ExtensionAPI);
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
