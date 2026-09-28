import type {
  ExtensionAPI,
  ExtensionCommandContext,
  KeybindingsManager,
  Skill,
  Theme,
} from "@earendil-works/pi-coding-agent";
import {
  type Component,
  type Focusable,
  Input,
  truncateToWidth,
  wrapTextWithAnsi,
} from "@earendil-works/pi-tui";

export function searchSkills(skills: Skill[], query: string): Skill[] {
  const terms = query.toLowerCase().trim().split(/\s+/).filter(Boolean);
  const sorted = [...skills].sort((a, b) => a.name.localeCompare(b.name));

  if (!terms.length) return sorted;

  return sorted
    .filter((skill) =>
      terms.every((term) => `${skill.name} ${skill.description}`.toLowerCase().includes(term)),
    )
    .sort((a, b) => {
      const nameMatches = (skill: Skill) =>
        terms.every((term) => skill.name.toLowerCase().includes(term));

      return Number(nameMatches(b)) - Number(nameMatches(a));
    });
}

export class SkillPicker implements Component, Focusable {
  private input = new Input({ placeholder: "Search skills by name or description" });
  private matches: Skill[];
  private cursor = 0;
  private detailOffset = 0;
  private _focused = false;

  get focused(): boolean {
    return this._focused;
  }
  set focused(value: boolean) {
    this._focused = value;
    this.input.focused = value;
  }

  constructor(
    private skills: Skill[],
    private tui: { terminal: { rows: number }; requestRender(): void },
    private theme: Pick<Theme, "fg" | "bold">,
    private keys: Pick<KeybindingsManager, "matches">,
    private done: (skill: Skill | undefined) => void,
  ) {
    this.matches = searchSkills(skills, "");
  }

  handleInput(data: string): void {
    if (this.keys.matches(data, "tui.select.cancel")) {
      this.done(undefined);

      return;
    }

    if (this.keys.matches(data, "tui.select.confirm")) {
      const selected = this.matches[this.cursor];

      if (selected) this.done(selected);

      return;
    }

    if (this.keys.matches(data, "tui.select.up")) {
      this.cursor = Math.max(0, this.cursor - 1);
    } else if (this.keys.matches(data, "tui.select.down")) {
      this.cursor = Math.max(0, Math.min(this.matches.length - 1, this.cursor + 1));
    } else if (this.keys.matches(data, "tui.select.pageUp")) {
      this.detailOffset = Math.max(0, this.detailOffset - 5);
    } else if (this.keys.matches(data, "tui.select.pageDown")) {
      this.detailOffset += 5;
    } else {
      const before = this.input.getValue();
      this.input.handleInput(data);

      if (before !== this.input.getValue()) {
        this.matches = searchSkills(this.skills, this.input.getValue());
        this.cursor = 0;
        this.detailOffset = 0;
      }
    }

    if (this.keys.matches(data, "tui.select.up") || this.keys.matches(data, "tui.select.down")) {
      this.detailOffset = 0;
    }

    this.tui.requestRender();
  }

  invalidate(): void {}

  render(width: number): string[] {
    const height = Math.max(0, this.tui.terminal.rows - 2);

    if (height < 12) {
      return ["Enlarge terminal to browse skills", "Esc to close"]
        .slice(0, height)
        .map((line) => truncateToWidth(line, width));
    }

    // Reserve header, metadata and footer rows; give the list the remaining space.
    const descriptionRows = Math.max(1, Math.min(10, Math.floor((height - 10) / 3)));
    const pageSize = height - 10 - descriptionRows;

    const start = Math.max(
      0,
      Math.min(this.cursor - Math.floor(pageSize / 2), this.matches.length - pageSize),
    );

    const lines = [
      this.theme.fg("accent", this.theme.bold(`Skills · ${this.skills.length} available`)),
      ...this.input.render(width),
      this.theme.fg(
        "dim",
        `${this.matches.length} matches · ${this.matches.length ? this.cursor + 1 : 0} selected`,
      ),
    ];

    for (const [index, skill] of this.matches.slice(start, start + pageSize).entries()) {
      const row = `${start + index === this.cursor ? "›" : " "} ${skill.name}`;
      lines.push(start + index === this.cursor ? this.theme.fg("accent", row) : row);
    }

    if (!this.skills.length) lines.push(this.theme.fg("muted", "No skills loaded in this session"));
    else if (!this.matches.length) lines.push(this.theme.fg("muted", "No matching skills"));

    // Keep details in place when filtering reduces the number of matches.
    while (lines.length < 3 + pageSize) lines.push("");

    const selected = this.matches[this.cursor];

    if (selected) {
      const source = selected.sourceInfo;
      lines.push(
        "",
        this.theme.bold(selected.name + (selected.disableModelInvocation ? " · manual-only" : "")),
        `Source: ${source.scope} · ${source.source}`,
        `Path: ${selected.filePath}`,
        this.theme.fg("muted", "Description:"),
      );
      const description = wrapTextWithAnsi(selected.description, Math.max(1, width));
      const available = Math.max(1, height - lines.length - 2);
      this.detailOffset = Math.min(this.detailOffset, Math.max(0, description.length - available));
      lines.push(...description.slice(this.detailOffset, this.detailOffset + available));

      while (lines.length < height - 2) lines.push("");

      if (description.length > available) {
        lines.push(
          this.theme.fg(
            "dim",
            `Details ${this.detailOffset + 1}–${Math.min(this.detailOffset + available, description.length)}/${description.length} · PgUp/Dn`,
          ),
        );
      }
    }

    // A fixed height prevents the centered overlay from moving between selections.
    while (lines.length < height - 1) lines.push("");
    lines.push(this.theme.fg("dim", "Enter select · Esc cancel"));

    return lines.slice(0, height).map((line) => truncateToWidth(line, width));
  }
}

export async function browseSkills(ctx: ExtensionCommandContext): Promise<void> {
  if (ctx.mode !== "tui") {
    ctx.ui.notify("/skills requires terminal interactive mode", "error");

    return;
  }

  const skills = ctx.getSystemPromptOptions().skills ?? [];

  const chosen = await ctx.ui.custom<Skill | undefined>(
    (tui, theme, keys, done) => new SkillPicker(skills, tui, theme, keys, done),
    { overlay: true, overlayOptions: { width: "100%", maxHeight: "100%", margin: 1 } },
  );

  if (chosen) ctx.ui.setEditorText(`/skill:${chosen.name} `);
}

export default function skillsExtension(pi: ExtensionAPI) {
  pi.registerCommand("skills", {
    description: "Search available skills and prepare a /skill:name invocation",
    handler: async (args, ctx) => {
      if (args.trim()) {
        ctx.ui.notify("Usage: /skills", "warning");

        return;
      }

      await browseSkills(ctx);
    },
  });
}
