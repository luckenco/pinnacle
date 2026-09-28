import assert from "node:assert/strict";
import { test } from "node:test";
import type { Api, Model } from "@earendil-works/pi-ai";
import {
  CURSOR_MARKER,
  KeybindingsManager,
  TUI_KEYBINDINGS,
  visibleWidth,
} from "@earendil-works/pi-tui";
import type { SubagentModels } from "./config";
import { ModelPicker } from "./picker";

const keys = new KeybindingsManager({
  ...TUI_KEYBINDINGS,
  "app.models.save": { defaultKeys: "ctrl+s" },
  "app.models.reorderUp": { defaultKeys: "alt+up" },
  "app.models.reorderDown": { defaultKeys: "alt+down" },
});
const theme = {
  fg: (_color: unknown, text: string) => `\x1b[36m${text}\x1b[0m`,
  bold: (text: string) => `\x1b[1m${text}\x1b[22m`,
};
const available = [
  { provider: "codex", id: "eye", name: "Reasoner", reasoning: true },
  { provider: "router", id: "family/reviewer", name: "Independent reviewer", reasoning: true },
  { provider: "codex", id: "hand", name: "Implementer 界", reasoning: false },
] as Model<Api>[];
const empty = (): SubagentModels => ({ eye: [], hand: null, reasoning: { eye: {}, hand: null } });

function open(initial: SubagentModels = empty(), models: Model<Api>[] | null = available) {
  const results: (SubagentModels | undefined)[] = [];
  const tui = { terminal: { rows: 26 }, requestRender: () => {} };
  const picker = new ModelPicker(models, initial, tui as never, theme, keys, (result) =>
    results.push(result),
  );
  return { picker, results, tui };
}

test("Enter requires an explicit supported reasoning level before adding an eye", () => {
  const { picker, results } = open();
  picker.handleInput("Independent");
  picker.handleInput("\r");
  assert.match(picker.render(100).join("\n"), /EYE › router\/family\/reviewer › reasoning/);
  picker.handleInput("\x13"); // Save cannot bypass the level choice.
  assert.deepEqual(results, []);
  picker.handleInput("\x1b[B"); // off
  picker.handleInput("\x1b[B"); // minimal
  picker.handleInput("\x1b[B"); // low
  picker.handleInput("\r");
  picker.handleInput("\x13");
  assert.deepEqual(results, [
    {
      eye: ["router/family/reviewer"],
      hand: null,
      reasoning: { eye: { "router/family/reviewer": "low" }, hand: null },
    },
  ]);
});

test("existing eye levels edit independently and reordered entries keep their levels", () => {
  const initial: SubagentModels = {
    eye: ["codex/eye"],
    hand: null,
    reasoning: { eye: { "codex/eye": "high" }, hand: null },
  };
  const { picker, results } = open(initial);
  picker.handleInput("Independent");
  picker.handleInput("\r");
  picker.handleInput("\x1b[B");
  picker.handleInput("\r"); // Explicit off.
  picker.handleInput("\x1b[1;3A"); // Promote the filtered row.
  picker.handleInput("\x13");
  assert.deepEqual(results[0], {
    eye: ["router/family/reviewer", "codex/eye"],
    hand: null,
    reasoning: { eye: { "codex/eye": "high", "router/family/reviewer": "off" }, hand: null },
  });
  assert.deepEqual(initial.reasoning.eye, { "codex/eye": "high" });
});

test("search preserves assigned eye order while reordering matching rows", () => {
  const models = [
    { provider: "test", id: "alphabet", name: "Alphabet", reasoning: true },
    { provider: "test", id: "alpha", name: "Alpha", reasoning: true },
  ] as Model<Api>[];
  const { picker, results } = open(
    {
      eye: ["test/alphabet", "test/alpha"],
      hand: null,
      reasoning: { eye: { "test/alphabet": "high", "test/alpha": "low" }, hand: null },
    },
    models,
  );
  picker.handleInput("alpha");
  const before = picker.render(100).join("\n");
  assert.ok(before.indexOf("test/alphabet ·") < before.indexOf("test/alpha ·"));
  picker.handleInput("\x1b[1;3B");
  picker.handleInput("\x13");
  assert.deepEqual(results[0]?.eye, ["test/alpha", "test/alphabet"]);
});

test("hand replacement requires reasoning even for off-only models, and can overlap eye", () => {
  const initial: SubagentModels = {
    eye: ["codex/eye"],
    hand: "codex/hand",
    reasoning: { eye: { "codex/eye": "high" }, hand: "off" },
  };
  const { picker, results } = open(initial);
  picker.handleInput("\t");
  picker.handleInput("codex/eye");
  picker.handleInput("\r");
  picker.handleInput("\x1b[B");
  picker.handleInput("\r"); // Choose off, do not inherit the eye's high.
  picker.handleInput("\x13");
  assert.deepEqual(results[0], {
    eye: ["codex/eye"],
    hand: "codex/eye",
    reasoning: { eye: { "codex/eye": "high" }, hand: "off" },
  });
  picker.handleInput("\x15"); // Clear query.
  picker.handleInput("codex/hand");
  picker.handleInput("\r");
  assert.match(picker.render(100).join("\n"), /HAND › codex\/hand › reasoning/);
  assert.ok(!picker.render(100).join("\n").includes("minimal"));
  picker.handleInput("\x1b[B");
  picker.handleInput("\r"); // Explicit off required even when it is the only level.
  picker.handleInput("\x13");
  assert.equal(results[1]?.hand, "codex/hand");
});

test("editing a different hand model does not preselect the previous model's level", () => {
  const { picker } = open({
    eye: [],
    hand: "codex/eye",
    reasoning: { eye: {}, hand: "high" },
  });
  picker.handleInput("\t");
  picker.handleInput("codex/hand");
  picker.handleInput("\r");
  assert.match(picker.render(100).join("\n"), /Choose a supported level/);
});

test("unsupported saved level requires an explicit new selection", () => {
  const initial: SubagentModels = {
    eye: ["codex/hand"],
    hand: null,
    reasoning: { eye: { "codex/hand": "high" }, hand: null },
  };
  const { picker, results } = open(initial, [available[2]]);
  picker.handleInput("\r");
  picker.handleInput("\r"); // Cannot silently clamp high to off.
  picker.handleInput("\x1b");
  picker.handleInput("\x13");
  assert.deepEqual(results[0], initial);
  picker.handleInput("\r");
  picker.handleInput("\x1b[B");
  picker.handleInput("\r");
  picker.handleInput("\x13");
  assert.equal(results[1]?.reasoning.eye["codex/hand"], "off");
});

test("reasoning hints use the configured navigation, confirm and cancel keys", () => {
  const remapped = new KeybindingsManager(
    {
      ...TUI_KEYBINDINGS,
      "app.models.save": { defaultKeys: "ctrl+s" },
      "app.models.reorderUp": { defaultKeys: "alt+up" },
      "app.models.reorderDown": { defaultKeys: "alt+down" },
    },
    {
      "tui.select.down": "alt+j",
      "tui.select.confirm": "alt+k",
      "tui.select.cancel": "alt+l",
    },
  );
  const tui = { terminal: { rows: 26 }, requestRender: () => {} };
  const picker = new ModelPicker(available, empty(), tui as never, theme, remapped, () => {});
  picker.handleInput("\x1bk");
  const lines = picker.render(100).join("\n");
  assert.match(lines, /alt\+j/);
  assert.match(lines, /alt\+k apply/);
  assert.match(lines, /alt\+l back/);
});

test("Escape backs out of a reasoning choice without changing the draft", () => {
  const { picker, results } = open();
  picker.handleInput("\r");
  picker.handleInput("\x1b[B");
  picker.handleInput("\x1b");
  picker.handleInput("\x13");
  assert.deepEqual(results, [empty()]);
  picker.handleInput("\x1b");
  assert.deepEqual(results, [empty(), undefined]);
});

test("Remove drops eye and hand independently and prunes their reasoning", () => {
  const initial: SubagentModels = {
    eye: ["codex/eye"],
    hand: "codex/eye",
    reasoning: { eye: { "codex/eye": "high" }, hand: "high" },
  };
  const { picker, results } = open(initial);
  picker.handleInput("\r");
  picker.handleInput("\x1b[B"); // After high comes Remove.
  picker.handleInput("\r");
  picker.handleInput("\t");
  picker.handleInput("\r");
  picker.handleInput("\x1b[B");
  picker.handleInput("\r");
  picker.handleInput("\x13");
  assert.deepEqual(results[0], empty());
  assert.equal(initial.eye[0], "codex/eye");
});

test("unavailable saved assignments and unsupported levels remain visible until explicitly changed", () => {
  const initial: SubagentModels = {
    eye: ["gone/eye", "codex/hand"],
    hand: "gone/hand",
    reasoning: { eye: { "gone/eye": "high", "codex/hand": "high" }, hand: "low" },
  };
  const { picker, results } = open(initial, [available[2]]);
  assert.match(picker.render(100).join("\n"), /unavailable/);
  picker.handleInput("\x13");
  assert.deepEqual(results[0], initial);
  picker.handleInput("\r");
  assert.match(picker.render(100).join("\n"), /remove/);
  picker.handleInput("\x1b"); // Don't remove on cancel.
  picker.handleInput("\r");
  picker.handleInput("\r"); // Remove gone/eye, only available action.
  picker.handleInput("\x13");
  assert.deepEqual(results[1]?.reasoning.eye, { "codex/hand": "high" });
  assert.match(picker.render(100).join("\n"), /unsupported/);
  picker.handleInput("\t");
  picker.handleInput("\r"); // Unavailable hand: remove only.
  picker.handleInput("\r");
  picker.handleInput("\x13");
  assert.deepEqual(results[2]?.hand, null);
  assert.equal(results[2]?.reasoning.hand, null);
});

test("no-match, tiny panes and resizing keep choices visible and avoid blind editing", () => {
  const models = Array.from({ length: 30 }, (_, i) => ({
    provider: "test",
    id: `model-${String(i).padStart(2, "0")}`,
    name: "Model",
    reasoning: true,
  })) as Model<Api>[];
  const { picker, results, tui } = open(undefined, models);
  picker.handleInput("\x1b[6~");
  assert.match(picker.render(100).join("\n"), /9\/30 matches/);
  picker.handleInput("\r");
  for (const height of [24, 18, 10, 5, 30]) {
    tui.terminal.rows = height + 2;
    const lines = picker.render(80);
    assert.ok(lines.length <= height);
    assert.ok(lines.some((line) => line.includes("Choose a supported level")));
  }
  tui.terminal.rows = 5;
  picker.render(80);
  picker.handleInput("\r");
  picker.handleInput("\x13");
  assert.deepEqual(results, []);
  picker.handleInput("\x1b");
  tui.terminal.rows = 26; // Restored terminal size.
  picker.handleInput("no-such-model");
  for (const key of ["\r", "\x1b[A", "\x1b[B", "\x1b[6~"]) picker.handleInput(key);
  picker.handleInput("\x13");
  assert.deepEqual(results, [empty()]);
});

test("rendering fits narrow widths and forwards focus to the active input", () => {
  const { picker } = open();
  picker.focused = true;
  picker.handleInput("界");
  assert.ok(picker.render(80).some((line) => line.includes(CURSOR_MARKER)));
  for (const width of [1, 10, 24, 80]) {
    for (const line of picker.render(width)) assert.ok(visibleWidth(line) <= width);
    picker.invalidate();
  }
  picker.handleInput("\x15");
  picker.handleInput("\r");
  assert.ok(picker.render(80).every((line) => !line.includes(CURSOR_MARKER)));
  picker.focused = false;
  picker.handleInput("\x1b");
  assert.ok(picker.render(80).every((line) => !line.includes(CURSOR_MARKER)));
});
