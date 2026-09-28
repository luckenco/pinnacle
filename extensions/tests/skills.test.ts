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
  const terminal = { rows };

  const picker = new SkillPicker(skills, { terminal, requestRender() {} }, theme, keys, (value) =>
    results.push(value),
  );

  picker.focused = true;

  return { picker, results, terminal };
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

test("list shows only names while descriptions remain in details and search", () => {
  const { picker } = open();
  const lines = picker.render(100);
  assert.deepEqual(lines.slice(3, 6), ["› alpha", "  database", "  zebra"]);
  assert.equal(lines[lines.indexOf("Description:") + 1], "text workflows");

  picker.handleInput("workflows");
  const filtered = picker.render(100);
  assert.match(filtered.join("\n"), /1 matches · 1 selected/);
  assert.equal(filtered[3], "› alpha");
  assert.equal(filtered[filtered.indexOf("Description:") + 1], "text workflows");
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

test("navigation, detail scrolling and filtering keep layout positions stable", () => {
  const skills = [skill("brief", "Short."), skill("verbose", "界 words ".repeat(200))];

  for (const rows of [14, 26, 60]) {
    for (const width of [28, 100]) {
      const { picker } = open(skills, rows);
      const before = picker.render(width);
      const descriptionRow = before.indexOf("Description:");
      assert.ok(descriptionRow > 0);
      assert.equal(before.length, rows - 2);

      for (const input of ["\x1b[B", "\x1b[6~", "\x1b[5~", "verbose", "missing"]) {
        picker.handleInput(input);
        const lines = picker.render(width);
        assert.equal(lines.length, before.length);
        assert.equal(lines[0], before[0]);
        assert.equal(lines.at(-1), before.at(-1));
        assert.ok(lines.every((line) => visibleWidth(line) <= width));

        if (input === "missing") assert.match(lines.join("\n"), /No matching skills/);
        else assert.equal(lines.indexOf("Description:"), descriptionRow);
      }

      assert.equal(open([], rows).picker.render(width).length, before.length);
    }
  }
});

test("larger terminals show more skills and resizing keeps the selection visible", () => {
  const skills = Array.from({ length: 80 }, (_, i) =>
    skill(`skill-${String(i).padStart(2, "0")}`, "Description."),
  );

  const { picker, terminal, results } = open(skills, 26);
  const small = picker.render(100).filter((line) => /^[› ] skill-/.test(line)).length;

  terminal.rows = 60;
  const large = picker.render(100);
  assert.equal(large.length, 58);
  assert.ok(large.filter((line) => /^[› ] skill-/.test(line)).length > small);
  assert.ok(large.filter((line) => /^[› ] skill-/.test(line)).length > 8);

  for (let i = 0; i < skills.length; i++) picker.handleInput("\x1b[B");

  for (const rows of [60, 20, 14, 80]) {
    terminal.rows = rows;
    const lines = picker.render(60);
    assert.equal(lines.length, rows - 2);
    assert.match(lines.join("\n"), /› skill-79/);
    assert.equal(lines.at(-1), "Enter select · Esc cancel");
  }

  picker.handleInput("\r");
  assert.deepEqual(results, [skills.at(-1)]);
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
