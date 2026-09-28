import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import type { Api, Model } from "@earendil-works/pi-ai";
import type {
  ExtensionAPI,
  ExtensionCommandContext,
  Theme,
  RegisteredCommand,
  ThemeColor,
  KeybindingsManager as AgentKeybindingsManager,
} from "@earendil-works/pi-coding-agent";
import {
  KeybindingsManager,
  TUI_KEYBINDINGS,
  type Component,
  type TUI,
} from "@earendil-works/pi-tui";
import { loadConfig, type SubagentModels } from "./config";
import extension, { configure } from "./index";

let root: string;

let path: string;

let notices: string[];

let events: string[];

let draft: SubagentModels | undefined;

let ctx: ExtensionCommandContext;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "subagent-models-command-"));
  path = join(root, "models.json");
  notices = [];
  events = [];
  draft = undefined;

  const registry: Partial<ExtensionCommandContext["modelRegistry"]> = {
    refresh: async (options: { allowNetwork: boolean }) => {
      assert.equal(options.allowNetwork, false);
      events.push("refresh");

      return { aborted: false, errors: new Map() };
    },
    getError: () => undefined,
    getAvailable: () => {
      events.push("available");

      return [];
    },
  };

  const ui: Partial<ExtensionCommandContext["ui"]> = {
    notify: (message: string) => notices.push(message),
    custom: async <T>(
      _factory: Parameters<ExtensionCommandContext["ui"]["custom"]>[0],
      options: { overlay?: boolean },
    ) => {
      assert.equal(options.overlay, true);
      events.push("picker");

      // SAFETY: configure calls custom with T = SubagentModels | undefined.
      return draft as T;
    },
  };

  // SAFETY: configure only calls these registry and UI methods on this context fixture.
  const fixture: Partial<ExtensionCommandContext> = {
    mode: "tui",
    modelRegistry: registry as ExtensionCommandContext["modelRegistry"],
    ui: ui as ExtensionCommandContext["ui"],
  };

  // SAFETY: configure and the registered command only read the context fields above.
  ctx = fixture as ExtensionCommandContext;
});

afterEach(() => rmSync(root, { recursive: true, force: true }));

test("refresh precedes choices; cancel and incomplete Save never write a file", async () => {
  await configure(ctx, path);
  assert.deepEqual(events, ["refresh", "available", "picker"]);
  assert.equal(loadConfig(path).raw, null);
  draft = { eye: [], hand: null, reasoning: { eye: {}, hand: null } };
  await configure(ctx, path);
  assert.equal(loadConfig(path).raw, null);
  assert.match(notices.at(-1) ?? "", /at least one eye and one hand/);
});

test("command picker selects, saves and reloads a model ID with spaces; refresh failure remains removable", async () => {
  const model: Model<Api> = {
    provider: "custom",
    id: "my model",
    name: "Custom model",
    reasoning: true,
    api: "openai-completions",
    baseUrl: "https://example.invalid",
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 1000,
    maxTokens: 100,
  };

  ctx.modelRegistry.getAvailable = () => [model];

  const keys = new KeybindingsManager({
    ...TUI_KEYBINDINGS,
    "app.models.save": { defaultKeys: "ctrl+s" },
    "app.models.reorderUp": { defaultKeys: "alt+up" },
    "app.models.reorderDown": { defaultKeys: "alt+down" },
  });

  const theme = { fg: (_color: ThemeColor, text: string) => text, bold: (text: string) => text };
  const tui = { terminal: { rows: 26 }, requestRender: () => {} };
  let failed = false;
  ctx.ui.custom = async <T>(
    factory: (
      tui: TUI,
      theme: Theme,
      keys: AgentKeybindingsManager,
      done: (value: T) => void,
    ) => Component | Promise<Component>,
  ) => {
    return new Promise<T>((done) => {
      // SAFETY: ModelPicker only reads terminal.rows and requestRender from this TUI fixture.
      const mockTui = tui as TUI;
      // SAFETY: ModelPicker only calls fg and bold on this theme fixture.
      const mockTheme = theme as Theme;
      // SAFETY: ModelPicker only calls matches and getKeys on this keybindings fixture.
      const mockKeys = keys as AgentKeybindingsManager;

      const picker = factory(mockTui, mockTheme, mockKeys, done);
      assert.ok(!(picker instanceof Promise));
      assert.ok(picker.handleInput);

      if (failed) {
        assert.match(picker.render(80).join("\n"), /catalog unavailable/);
        assert.doesNotMatch(picker.render(80).join("\n"), /\[unavailable\]/);
        picker.handleInput("\x1b");

        return;
      }

      picker.handleInput("my model");
      picker.handleInput("\r");
      picker.handleInput("\x1b[B"); // off
      picker.handleInput("\x1b[B"); // minimal
      picker.handleInput("\r");
      picker.handleInput("\t");
      picker.handleInput("\r");
      picker.handleInput("\x1b[B"); // off
      picker.handleInput("\r");
      picker.handleInput("\x13");
    });
  };

  await configure(ctx, path);
  assert.deepEqual(loadConfig(path).config, {
    eye: ["custom/my model"],
    hand: "custom/my model",
    reasoning: { eye: { "custom/my model": "minimal" }, hand: "off" },
  });
  assert.match(notices.join("\n"), /Saved subagent model preferences/);
  failed = true;
  ctx.modelRegistry.refresh = async () => {
    throw new Error("offline");
  };

  await configure(ctx, path);
  assert.deepEqual(loadConfig(path).config, {
    eye: ["custom/my model"],
    hand: "custom/my model",
    reasoning: { eye: { "custom/my model": "minimal" }, hand: "off" },
  });
});

test("malformed config and unsupported UI modes stop before refresh or picker", async () => {
  writeFileSync(path, "bad json");
  await configure(ctx, path);
  assert.deepEqual(events, []);
  assert.equal(readFileSync(path, "utf8"), "bad json");

  for (const mode of ["rpc", "json", "print"] as const) {
    ctx.mode = mode;
    await configure(ctx, path);
    assert.match(notices.at(-1) ?? "", /requires TUI/);
  }

  assert.deepEqual(events, []);
});

test("refresh failures never use a stale availability snapshot", async () => {
  for (const failure of ["throw", "aborted", "provider", "config"]) {
    events.length = 0;
    ctx.modelRegistry.refresh = async () => {
      if (failure === "throw") throw new Error("offline");

      return {
        aborted: failure === "aborted",
        errors: new Map(failure === "provider" ? [["router", new Error("provider failed")]] : []),
      };
    };

    ctx.modelRegistry.getError = () => (failure === "config" ? "bad models.json" : undefined);
    await configure(ctx, path);
    assert.deepEqual(events, ["picker"]);
    assert.match(notices.at(-1) ?? "", /new assignments disabled/);
  }
});

test("a config edit while the picker is open is not overwritten", async () => {
  const other = '{"eye":["other/model"],"hand":null}';
  ctx.ui.custom = async <T>() => {
    writeFileSync(path, other);

    const draft = {
      eye: ["local/model"],
      hand: "local/hand",
      reasoning: { eye: { "local/model": "high" }, hand: "low" },
    } satisfies SubagentModels;

    // SAFETY: configure calls custom<SubagentModels | undefined> for this stub.
    return draft as T;
  };

  await configure(ctx, path);
  assert.equal(readFileSync(path, "utf8"), other);
  assert.match(notices.join("\n"), /changed in another session/);
});

test("extension registers the command, warns at startup, and supplies role context", async () => {
  let command: Omit<RegisteredCommand, "name" | "sourceInfo"> | undefined;
  const handlers = new Map<string, (...args: never[]) => void>();

  // SAFETY: the extension only registers handlers and the command during initialization.
  const api: Partial<ExtensionAPI> = {
    on: (name: string, handler: (...args: never[]) => void) => {
      handlers.set(name, handler);

      return () => {};
    },
    registerCommand: (name: string, options: Omit<RegisteredCommand, "name" | "sourceInfo">) => {
      assert.equal(name, "subagent-models");
      command = options;
    },
  };

  // SAFETY: this fixture implements the registration methods called by the extension.
  extension(api as ExtensionAPI, path);
  assert.ok(command);

  // SAFETY: this session_start handler only reads ctx.hasUI and ctx.ui.notify.
  handlers.get("session_start")?.({} as never, { ...ctx, hasUI: true } as never);
  assert.match(notices.join("\n"), /not configured.*eye, hand missing/);

  const prompt = {
    systemPromptOptions: { selectedTools: ["subagent"], sections: { subagent_models: "" } },
  };

  // SAFETY: the handler only reads selectedTools and writes sections on this prompt.
  handlers.get("before_agent_start")?.(prompt as never, ctx as never);
  assert.match(
    prompt.systemPromptOptions.sections.subagent_models,
    /role-based dispatch will fail/,
  );

  writeFileSync(
    path,
    JSON.stringify({
      eye: ["test/eye"],
      hand: "test/hand",
      reasoning: { eye: { "test/eye": "high" }, hand: "low" },
    }),
  );

  const configuredPrompt = {
    systemPromptOptions: { selectedTools: ["subagent"], sections: { subagent_models: "" } },
  };

  // SAFETY: the handler only reads selectedTools and writes sections on this prompt.
  handlers.get("before_agent_start")?.(configuredPrompt as never, ctx as never);
  assert.match(
    configuredPrompt.systemPromptOptions.sections.subagent_models,
    /1\. test\/eye @ high.*Hand: test\/hand @ low/,
  );

  await command.handler("unexpected", ctx);
  assert.match(notices.join("\n"), /Usage: \/subagent-models/);
  assert.deepEqual(events, []);
});
