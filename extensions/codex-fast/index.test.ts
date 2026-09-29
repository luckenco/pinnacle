import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import { type Model, type StreamOptions } from "@earendil-works/pi-ai";
import {
  type ExtensionAPI,
  type ExtensionCommandContext,
  type RegisteredCommand,
  ModelRegistry,
  ModelRuntime,
} from "@earendil-works/pi-coding-agent";
import extension, { isCodex, loadFastMode } from "./index";

const model = (id = "gpt-6-astra"): Model<"openai-codex-responses"> => ({
  id,
  name: id,
  provider: "openai-codex",
  api: "openai-codex-responses",
  baseUrl: "https://example.invalid",
  reasoning: true,
  input: ["text"],
  cost: { input: 1, output: 2, cacheRead: 0.1, cacheWrite: 0 },
  contextWindow: 128000,
  maxTokens: 4096,
});

const context = { messages: [] };

const token = Buffer.from(
  JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "test" } }),
).toString("base64url");

let root: string;

let path: string;

let registry: ModelRegistry;

let ctx: ExtensionCommandContext;

let command: Omit<RegisteredCommand, "name" | "sourceInfo">;

let api: Partial<ExtensionAPI>;

let payloads: string[];

let notices: string[];

let status: string | undefined;

let request: StreamOptions;

let responseTier: string | undefined;

let requestHeaders: Headers;

const handlers = new Map<string, (...args: never[]) => void>();

function emit(name: string): void {
  // SAFETY: these lifecycle handlers only use ctx; the unused event is empty.
  handlers.get(name)?.({} as never, ctx as never);
}

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), "codex-fast-"));
  path = join(root, "extensions", "codex-fast.json");
  writeFileSync(
    join(root, "auth.json"),
    JSON.stringify({
      "openai-codex": {
        type: "oauth",
        access: `test.${token}.test`,
        refresh: "unused",
        expires: Date.now() + 3_600_000,
      },
    }),
  );

  const runtime = await ModelRuntime.create({
    authPath: join(root, "auth.json"),
    modelsPath: join(root, "models.json"),
    modelsStorePath: join(root, "models-store.json"),
    refreshOnCreate: false,
  });

  registry = new ModelRegistry(runtime);
  payloads = [];
  responseTier = "default";
  requestHeaders = new Headers();
  notices = [];
  status = undefined;
  handlers.clear();
  api = {
    on: (name: string, handler: (...args: never[]) => void) => {
      handlers.set(name, handler);

      return () => {};
    },
    registerProvider: registry.registerProvider.bind(registry),
    unregisterProvider: registry.unregisterProvider.bind(registry),
    registerCommand: (name, options) => {
      assert.equal(name, "fast");
      command = options;
    },
  };

  const ui: Partial<ExtensionCommandContext["ui"]> = {
    notify: (message) => notices.push(message),
    setStatus: (key, value) => {
      assert.equal(key, "codex-fast");
      status = value;
    },
    // SAFETY: syncStatus only calls theme.fg; colors are irrelevant to these tests.
    theme: { fg: (_color, text) => text } as ExtensionCommandContext["ui"]["theme"],
  };

  // SAFETY: the extension only reads model, modelRegistry, hasUI, and the UI methods above.
  ctx = { model: model(), modelRegistry: registry, hasUI: true, ui } as ExtensionCommandContext;
  request = {
    transport: "sse",
    onPayload: (payload) => {
      payloads.push(JSON.stringify(payload));
    },
    fetch: async (_url, init) => {
      requestHeaders = new Headers(init?.headers);

      return new Response(
        `data: ${JSON.stringify({
          type: "response.completed",
          response: {
            id: "test",
            status: "completed",
            service_tier: responseTier,
            output: [],
            usage: { input_tokens: 1000, output_tokens: 100, total_tokens: 1100 },
          },
        })}\n\n`,
        { headers: { "content-type": "text/event-stream" } },
      );
    },
  };
  // SAFETY: the fixture implements every registration method used by the extension.
  await extension(api as ExtensionAPI, root);
  emit("session_start");
});

afterEach(() => rmSync(root, { recursive: true, force: true }));

test("Codex detection is provider-scoped, not model-name-scoped", () => {
  for (const id of ["gpt-6-astra", "gpt-5.6-sol", "future-model"]) {
    assert.ok(isCodex(model(id)));
    assert.equal(isCodex({ ...model(id), provider: "openai" }), false);
  }

  assert.equal(isCodex(undefined), false);
});

test("registered full streams preserve options and priority fallback pricing", async () => {
  for (const id of ["gpt-6-astra", "gpt-6-sol", "gpt-5.5", "future-model"]) {
    await command.handler("off", ctx);

    const options = {
      ...request,
      reasoningEffort: "high" as const,
      textVerbosity: "high" as const,
    };

    const normal = await registry.stream(model(id), context, options).result();
    assert.equal(normal.stopReason, "stop", normal.errorMessage);
    const ordinary = JSON.parse(payloads.at(-1)!);
    assert.equal(ordinary.service_tier, undefined);
    assert.equal(ordinary.reasoning.effort, "high");
    assert.equal(ordinary.text.verbosity, "high");

    await command.handler("on", ctx);
    const fast = await registry.stream(model(id), context, options).result();
    assert.equal(fast.stopReason, "stop", fast.errorMessage);
    assert.deepEqual(JSON.parse(payloads.at(-1)!), { ...ordinary, service_tier: "priority" });
    assert.equal(fast.usage.cost.total, normal.usage.cost.total * (id === "gpt-5.5" ? 2.5 : 2));
  }

  await command.handler("off", ctx);
  await registry.stream(model(), context, { ...request, serviceTier: "flex" }).result();
  assert.equal(JSON.parse(payloads.at(-1)!).service_tier, "flex");
});

test("simple streams preserve reasoning and tools while retaining priority pricing", async () => {
  for (const reasoning of [undefined, "high", "xhigh"] as const) {
    await command.handler("off", ctx);
    const options = { ...request, reasoning, toolChoice: "none" as const };
    const normal = await registry.streamSimple(model(), context, options).result();
    assert.equal(normal.stopReason, "stop", normal.errorMessage);
    const ordinary = JSON.parse(payloads.at(-1)!);
    assert.equal(ordinary.tool_choice, "none");

    await command.handler("on", ctx);
    const fast = await registry.streamSimple(model(), context, options).result();
    assert.equal(fast.stopReason, "stop", fast.errorMessage);
    assert.deepEqual(JSON.parse(payloads.at(-1)!), { ...ordinary, service_tier: "priority" });
    assert.equal(fast.usage.cost.total, normal.usage.cost.total * 2);
  }
});

test("command toggles, validates input, updates status, and restores persisted mode headlessly", async () => {
  assert.equal(status, undefined);
  await command.handler(" ON ", ctx);
  assert.equal(status, "⚡ Fast");
  assert.equal(loadFastMode(root), true);
  assert.deepEqual(readdirSync(join(root, "extensions")), ["codex-fast.json"]);

  await command.handler("invalid", ctx);
  assert.match(notices.at(-1)!, /Usage:/);
  assert.equal(loadFastMode(root), true);

  ctx.model = { ...model(), provider: "openrouter" };
  emit("model_select");
  assert.equal(status, undefined);
  ctx.model = model();
  emit("model_select");
  assert.equal(status, "⚡ Fast");
  emit("session_shutdown");
  assert.equal(status, undefined);

  ctx.hasUI = false;
  // SAFETY: same registration fixture, fresh extension instance as in a new child process.
  await extension(api as ExtensionAPI, root);
  emit("session_start");
  assert.equal(status, undefined);
  await registry.streamSimple(model(), context, request).result();
  assert.equal(JSON.parse(payloads.at(-1)!).service_tier, "priority");
  await command.handler("", ctx);
  assert.equal(loadFastMode(root), false);
});

test("failed atomic replacement leaves live mode and status unchanged and cleans temporary files", async () => {
  await command.handler("on", ctx);
  rmSync(path);
  mkdirSync(path);
  writeFileSync(join(path, "keep"), "untouched");
  await command.handler("off", ctx);
  assert.match(notices.at(-1)!, /Could not save Fast Mode:/);
  assert.equal(status, "⚡ Fast");
  assert.equal(readFileSync(join(path, "keep"), "utf8"), "untouched");
  assert.deepEqual(readdirSync(join(root, "extensions")), ["codex-fast.json"]);
  await registry.streamSimple(model(), context, request).result();
  assert.equal(JSON.parse(payloads.at(-1)!).service_tier, "priority");
});

test("model overrides and headers can be removed after registration and reload", async () => {
  emit("session_shutdown");
  const builtin = registry.getProvider("openai-codex")!.getModels()[0];
  const other = registry.getProvider("openai");
  const modelsPath = join(root, "models.json");
  writeFileSync(
    modelsPath,
    JSON.stringify({
      providers: {
        "openai-codex": {
          headers: { "x-fast-test": "old" },
          models: [{ id: "custom-codex", name: "Custom Codex" }],
          modelOverrides: { [builtin.id]: { name: "Overridden name" } },
        },
      },
    }),
  );
  await registry.refresh({ allowNetwork: false });
  // SAFETY: same registration fixture, simulating extension reload with existing overrides.
  await extension(api as ExtensionAPI, root);
  emit("session_start");
  assert.equal(registry.find("openai-codex", builtin.id)!.name, "Overridden name");
  assert.ok(registry.find("openai-codex", "custom-codex"));
  assert.equal(registry.getProvider("openai"), other);
  await command.handler("on", ctx);
  await registry.streamSimple(model(), context, request).result();
  assert.equal(requestHeaders.get("x-fast-test"), "old");
  assert.equal(requestHeaders.get("authorization"), `Bearer test.${token}.test`);

  writeFileSync(modelsPath, "{}");
  await registry.refresh({ allowNetwork: false });
  assert.equal(registry.find("openai-codex", builtin.id)!.name, builtin.name);
  assert.equal(registry.find("openai-codex", "custom-codex"), undefined);
  await registry.streamSimple(model(), context, request).result();
  assert.equal(requestHeaders.get("x-fast-test"), null);
  assert.equal(JSON.parse(payloads.at(-1)!).service_tier, "priority");
});

test("omitted response tiers retain priority pricing and non-reasoning models stay non-reasoning", async () => {
  responseTier = undefined;
  const noReasoning = { ...model(), reasoning: false };
  const options = { ...request, reasoning: "high" as const };
  const normal = await registry.streamSimple(noReasoning, context, options).result();
  assert.equal(normal.stopReason, "stop", normal.errorMessage);
  await command.handler("on", ctx);
  const fast = await registry.streamSimple(noReasoning, context, options).result();
  assert.equal(fast.stopReason, "stop", fast.errorMessage);
  assert.equal(JSON.parse(payloads.at(-1)!).reasoning, undefined);
  assert.equal(fast.usage.cost.total, normal.usage.cost.total * 2);
});

test("absent or malformed config safely defaults to off", () => {
  assert.equal(loadFastMode(root), false);
  mkdirSync(join(root, "extensions"));

  for (const value of ["{", '{"enabled":"true"}', "null", "[]"]) {
    writeFileSync(path, value);
    assert.equal(loadFastMode(root), false);
  }

  writeFileSync(path, '{"enabled":true}');
  assert.equal(loadFastMode(root), true);
});
