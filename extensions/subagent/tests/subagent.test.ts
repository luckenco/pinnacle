import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import { fileURLToPath } from "node:url";
import type {
  ExtensionAPI,
  ExtensionContext,
  ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { discoverAgents } from "../agents";
import subagent from "../index";

let root: string;
let tool: Pick<ToolDefinition, "execute">;
let ctx: ExtensionContext;
let previousDir: string | undefined;
let previousScript: string;

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "pinnacle-subagent-")));
  previousDir = process.env.PI_CODING_AGENT_DIR;
  previousScript = process.argv[1];
  process.env.PI_CODING_AGENT_DIR = join(root, "user");
  process.argv[1] = fileURLToPath(new URL("./fixtures/child.mjs", import.meta.url));
  ctx = {
    cwd: root,
    model: { provider: "test", id: "parent" },
    thinkingLevel: "high",
    hasUI: false,
    isProjectTrusted: () => false,
  } as ExtensionContext;
  subagent({
    registerTool: (definition) => {
      tool = definition;
    },
  } as ExtensionAPI);
});

afterEach(() => {
  process.argv[1] = previousScript;
  if (previousDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = previousDir;
  rmSync(root, { recursive: true, force: true });
});

function text(result: Awaited<ReturnType<ToolDefinition["execute"]>>) {
  const content = result.content[0];
  assert.equal(content.type, "text");
  return content.text;
}

function agent(dir: string, body: string) {
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "scout.md"),
    `---\nname: scout\ndescription: Override\n${body}\n---\nScoped prompt`,
  );
}

test("bundled agents work out of the box; user and opted-in project profiles override them", () => {
  const bundled = discoverAgents(root, "user").agents;
  assert.deepEqual(bundled.map((a) => a.name).sort(), ["planner", "reviewer", "scout", "worker"]);
  for (const profile of bundled) {
    assert.equal(profile.source, "bundled");
    assert.equal(profile.model, undefined);
    if (profile.name !== "worker") assert.deepEqual(profile.tools, ["read", "grep", "find", "ls"]);
  }
  agent(join(root, "user/agents"), "tools: [read, grep]\nmodel: test/override");
  agent(join(root, ".pi/agents"), "tools: read, find");
  writeFileSync(join(root, "user/agents/broken.md"), "---\nname: [\n---\n");
  const user = discoverAgents(root, "user").agents.find((a) => a.name === "scout");
  assert.equal(user?.source, "user");
  assert.deepEqual(user?.tools, ["read", "grep"]);
  assert.equal(
    discoverAgents(root, "both").agents.find((a) => a.name === "scout")?.source,
    "project",
  );
  const project = discoverAgents(root, "project").agents;
  assert.equal(project.length, 1);
  assert.deepEqual(project[0].tools, ["read", "find"]);
});

test("single dispatch inherits model/thinking, restricts tools, preserves output, and cleans prompts", async () => {
  const cwd = join(root, "workspace");
  mkdirSync(cwd);
  const result = await tool.execute(
    "single",
    { agent: "scout", task: "inspect", cwd },
    undefined,
    undefined,
    ctx,
  );
  const output = text(result);
  assert.ok(output.startsWith("inspect ✓\n"));
  const child = JSON.parse(output.split("\n")[1]);
  assert.equal(child.cwd, cwd);
  assert.equal(child.args[child.args.indexOf("--model") + 1], "test/parent");
  assert.equal(child.args[child.args.indexOf("--thinking") + 1], "high");
  assert.equal(child.args[child.args.indexOf("--tools") + 1], "read,grep,find,ls");
  assert.equal(child.args[child.args.indexOf("--exclude-tools") + 1], "subagent");
  assert.match(child.prompt, /You are a scout/);
  assert.equal(existsSync(child.promptPath), false);

  agent(join(root, "user/agents"), "model: test/override");
  const override = text(
    await tool.execute("override", { agent: "scout", task: "inspect" }, undefined, undefined, ctx),
  );
  const overrideArgs: string[] = JSON.parse(override.split("\n")[1]).args;
  assert.equal(overrideArgs[overrideArgs.indexOf("--model") + 1], "test/override");
  assert.equal(overrideArgs.includes("--thinking"), false);
});

test("parallel dispatch returns successful output alongside child failure diagnostics", async () => {
  const result = await tool.execute(
    "parallel",
    {
      tasks: [
        { agent: "scout", task: "inspect" },
        { agent: "reviewer", task: "fail" },
      ],
    },
    undefined,
    undefined,
    ctx,
  );
  assert.match(text(result), /1\/2 succeeded/);
  assert.match(text(result), /inspect ✓/);
  assert.match(text(result), /fixture failure/);
});

test("chains pass previous output and stop at the first failed child", async () => {
  const result = await tool.execute(
    "chain",
    {
      chain: [
        { agent: "scout", task: "first" },
        { agent: "planner", task: "after {previous}" },
      ],
    },
    undefined,
    undefined,
    ctx,
  );
  assert.match(text(result), /after first ✓/);
  await assert.rejects(
    tool.execute(
      "chain-fail",
      {
        chain: [
          { agent: "scout", task: "fail" },
          { agent: "missing", task: "must not run" },
        ],
      },
      undefined,
      undefined,
      ctx,
    ),
    /Chain stopped at step 1.*fixture failure/,
  );
  await assert.rejects(
    tool.execute("single-fail", { agent: "scout", task: "fail" }, undefined, undefined, ctx),
    /fixture failure/,
  );
});

test("untrusted project agents require approval even without a UI", async () => {
  agent(join(root, ".pi/agents"), "tools: read");
  await assert.rejects(
    tool.execute(
      "trust",
      { agent: "scout", task: "inspect", agentScope: "both" },
      undefined,
      undefined,
      ctx,
    ),
    /require approval/,
  );
  ctx.isProjectTrusted = () => true;
  const result = await tool.execute(
    "trusted",
    { agent: "scout", task: "inspect", agentScope: "both" },
    undefined,
    undefined,
    ctx,
  );
  assert.match(text(result), /Scoped prompt/);
});

test("cancellation kills a child that ignores SIGTERM and removes its temporary prompt", {
  timeout: 12000,
}, async () => {
  const controller = new AbortController();
  let child: { pid: number; promptPath: string } | undefined;
  try {
    await assert.rejects(
      tool.execute(
        "abort",
        { agent: "scout", task: "hang" },
        controller.signal,
        (update) => {
          if (child) return;
          child = JSON.parse(text(update).split("\n")[1]);
          controller.abort();
        },
        ctx,
      ),
      /aborted/,
    );
    assert.ok(child);
    const pid = child.pid;
    assert.throws(() => process.kill(pid, 0));
    assert.equal(existsSync(child.promptPath), false);
  } finally {
    if (child) {
      try {
        process.kill(child.pid, "SIGKILL");
      } catch {
        /* already exited */
      }
    }
  }
});
