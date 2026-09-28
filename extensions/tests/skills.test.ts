import assert from "node:assert/strict";
import { test } from "node:test";
import type { ExtensionCommandContext, Skill, Theme } from "@earendil-works/pi-coding-agent";
import { KeybindingsManager, TUI_KEYBINDINGS, visibleWidth } from "@earendil-works/pi-tui";
import { browseSkills, SkillPicker, searchSkills } from "../skills";

const keys = new KeybindingsManager(TUI_KEYBINDINGS);

const theme: Pick<Theme, "fg" | "bold"> = {
  fg: (_color, text) => text,
  bold: (text: string) => text,
};

function skill(name: string, description: string, manual = false): Skill {
  return {
    name,
    description,
    filePath: `/skills/${name}/SKILL.md`,
    baseDir: `/skills/${name}`,
    disableModelInvocation: manual,
    sourceInfo: {
      path: `/skills/${name}/SKILL.md`,
      source: "test",
      scope: "user",
      origin: "top-level",
    },
  };
}

const catalog = [
  skill("zebra", "database tools", true),
  skill("alpha", "text workflows"),
  skill("database", "other tools"),
];

function open(skills = catalog, rows = 26) {
  const results: (Skill | undefined)[] = [];

  const picker = new SkillPicker(
    skills,
    { terminal: { rows }, requestRender() {} },
    theme,
    keys,
    (value) => results.push(value),
  );

  picker.focused = true;

  return { picker, results };
}

test("alphabetical default and name matches before description matches", () => {
  assert.deepEqual(
    searchSkills(catalog, "").map((s) => s.name),
    ["alpha", "database", "zebra"],
  );
  assert.deepEqual(
    searchSkills(catalog, "DaTaBaSe").map((s) => s.name),
    ["database", "zebra"],
  );
  assert.deepEqual(
    searchSkills(catalog, "tools database").map((s) => s.name),
    ["database", "zebra"],
  );
  assert.deepEqual(
    searchSkills([skill("a-first", "database tools"), ...catalog], "database").map((s) => s.name),
    ["database", "a-first", "zebra"],
  );
});

test("picker searches descriptions, includes manual-only skills and selects without invoking", () => {
  const { picker, results } = open();
  assert.match(picker.render(100).join("\n"), /3 available/);
  picker.handleInput("zebra");
  const output = picker.render(100).join("\n");
  assert.match(output, /manual-only/);
  assert.match(output, /Path: \/skills\/zebra\/SKILL.md/);
  assert.match(output, /Source: user · test/);
  picker.handleInput("\r");
  assert.deepEqual(results, [catalog[0]]);
});

test("arrow navigation and searching reset the highlighted skill", () => {
  const { picker, results } = open();
  picker.handleInput("\x1b[B");
  assert.match(picker.render(80).join("\n"), /2 selected/);
  picker.handleInput("zebra");
  assert.match(picker.render(80).join("\n"), /1 matches · 1 selected/);
  picker.handleInput("\r");
  assert.deepEqual(results, [catalog[0]]);
});

test("no match cannot be selected, escape cancels, empty catalog is clear", () => {
  const { picker, results } = open();
  picker.handleInput("missing");
  assert.match(picker.render(60).join("\n"), /No matching skills/);
  picker.handleInput("\r");
  assert.deepEqual(results, []);
  picker.handleInput("\x1b");
  assert.deepEqual(results, [undefined]);
  assert.match(open([]).picker.render(60).join("\n"), /No skills loaded/);
});

test("long details can scroll and narrow layouts fit", () => {
  const { picker } = open([skill("verbose", "many words ".repeat(80))], 20);
  const before = picker.render(28).join("\n");
  picker.handleInput("\x1b[6~"); // Page Down: scroll description
  const after = picker.render(28);
  assert.notEqual(after.join("\n"), before);
  assert.ok(after.every((line) => visibleWidth(line) <= 28));
  assert.ok(after.length <= 18);
  assert.match(after.join("\n"), /Esc cancel/);
});

test("selection replaces an existing draft; cancellation preserves it", async () => {
  const editor: string[] = [];

  // SAFETY: browseSkills only accesses these command-context methods and fields.
  const context = (choice: Skill | undefined) =>
    Object.assign({} as ExtensionCommandContext, {
      mode: "tui",
      getSystemPromptOptions: () => ({ skills: catalog }),
      ui: {
        custom: async () => choice,
        setEditorText: (value: string) => editor.push(value),
      },
    });

  await browseSkills(context(catalog[0]));
  assert.deepEqual(editor, ["/skill:zebra "]);
  await browseSkills(context(undefined));
  assert.deepEqual(editor, ["/skill:zebra "]);
});
