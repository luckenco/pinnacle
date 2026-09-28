import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import type { Api, Model } from "@earendil-works/pi-ai";
import type {
  ExtensionAPI,
  ExtensionCommandContext,
  RegisteredCommand,
} from "@earendil-works/pi-coding-agent";
import { KeybindingsManager, TUI_KEYBINDINGS } from "@earendil-works/pi-tui";
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
  ctx = {
    mode: "tui",
    modelRegistry: {
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
    },
    ui: {
      notify: (message: string) => notices.push(message),
      custom: async (_factory: unknown, options: { overlay?: boolean }) => {
        assert.equal(options.overlay, true);
        events.push("picker");
        return draft;
      },
    },
  } as unknown as ExtensionCommandContext;
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

test("refresh precedes choices; cancel and unchanged Save never write a file", async () => {
  await configure(ctx, path);
  assert.deepEqual(events, ["refresh", "available", "picker"]);
  assert.equal(loadConfig(path).raw, null);
  draft = { eye: [], hand: null, reasoning: { eye: {}, hand: null } };
  await configure(ctx, path);
  assert.equal(loadConfig(path).raw, null);
});

test("command picker selects, saves and reloads a model ID with spaces; refresh failure remains removable", async () => {
  const model = {
    provider: "custom",
    id: "my model",
    name: "Custom model",
    reasoning: true,
  } as Model<Api>;
  ctx.modelRegistry.getAvailable = () => [model];
  const keys = new KeybindingsManager({
    ...TUI_KEYBINDINGS,
    "app.models.save": { defaultKeys: "ctrl+s" },
    "app.models.reorderUp": { defaultKeys: "alt+up" },
    "app.models.reorderDown": { defaultKeys: "alt+down" },
  });
  const theme = { fg: (_color: unknown, text: string) => text, bold: (text: string) => text };
  const tui = { terminal: { rows: 26 }, requestRender: () => {} };
  let failed = false;
  ctx.ui.custom = (async (
    factory: (
      tui: never,
      theme: never,
      keys: never,
      done: (value: SubagentModels | undefined) => void,
    ) => { handleInput: (key: string) => void; render: (width: number) => string[] },
  ) => {
    let chosen: SubagentModels | undefined;
    const picker = factory(tui as never, theme as never, keys as never, (value) => {
      chosen = value;
    });
    if (failed) {
      assert.match(picker.render(80).join("\n"), /catalog unavailable/);
      assert.doesNotMatch(picker.render(80).join("\n"), /\[unavailable\]/);
      picker.handleInput("\r"); // Saved assignment can only be removed.
      picker.handleInput("\r");
    } else {
      picker.handleInput("my model");
      picker.handleInput("\r");
      picker.handleInput("\x1b[B"); // off
      picker.handleInput("\x1b[B"); // minimal
      picker.handleInput("\r");
    }
    picker.handleInput("\x13");
    return chosen;
  }) as never;
  await configure(ctx, path);
  assert.deepEqual(loadConfig(path).config, {
    eye: ["custom/my model"],
    hand: null,
    reasoning: { eye: { "custom/my model": "minimal" }, hand: null },
  });
  assert.match(notices.join("\n"), /Saved.*Routing is unchanged/);
  failed = true;
  ctx.modelRegistry.refresh = async () => {
    throw new Error("offline");
  };
  await configure(ctx, path);
  assert.deepEqual(loadConfig(path).config, {
    eye: [],
    hand: null,
    reasoning: { eye: {}, hand: null },
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
  ctx.ui.custom = async () => {
    writeFileSync(path, other);
    return {
      eye: ["local/model"],
      hand: null,
      reasoning: { eye: { "local/model": "high" }, hand: null },
    } as never;
  };
  await configure(ctx, path);
  assert.equal(readFileSync(path, "utf8"), other);
  assert.match(notices.join("\n"), /changed in another session/);
});

test("extension only registers the configuration command and rejects arguments", async () => {
  let command: Omit<RegisteredCommand, "name" | "sourceInfo"> | undefined;
  extension({
    registerCommand: (name, options) => {
      assert.equal(name, "subagent-models");
      command = options;
    },
  } as ExtensionAPI);
  assert.ok(command);
  await command.handler("unexpected", ctx);
  assert.match(notices.join("\n"), /Usage: \/subagent-models/);
  assert.deepEqual(events, []);
});
