import type { ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { Key, matchesKey, type TUI, visibleWidth } from "@earendil-works/pi-tui";
import type { SkillChoice, SkillToggleUiResult } from "../types";
import { bottomBorder, combineColumns, divider, fit, frameLine, topBorder } from "./render";
import { filterSkills, modeLabel } from "./view-model";

export async function showSkillToggleUi(
  ctx: ExtensionContext,
  repository: string,
  choices: SkillChoice[],
): Promise<SkillToggleUiResult> {
  return ctx.ui.custom<SkillToggleUiResult>(
    (tui, theme, _keybindings, done) =>
      new SkillToggleOverlay(tui, theme, repository, choices, done),
    {
      overlay: true,
      overlayOptions: {
        anchor: "center",
        width: "92%",
        maxHeight: "88%",
        minWidth: 86,
      },
    },
  );
}

class SkillToggleOverlay {
  private readonly desired = new Map<string, boolean>();
  private search = "";
  private selectedIndex = 0;

  constructor(
    private readonly tui: TUI,
    private readonly theme: Theme,
    private readonly repository: string,
    private readonly choices: SkillChoice[],
    private readonly done: (result: SkillToggleUiResult) => void,
  ) {
    for (const choice of choices) this.desired.set(choice.skill.name, choice.modelEnabled);
  }

  handleInput(data: string): void {
    if (matchesKey(data, Key.escape) || matchesKey(data, Key.ctrl("c"))) {
      this.done({ action: "cancel", changes: {} });

      return;
    }

    if (matchesKey(data, Key.ctrl("s"))) {
      this.done({ action: "apply", changes: this.getChanges() });

      return;
    }

    if (matchesKey(data, Key.up)) {
      this.moveSelection(-1);

      return;
    }

    if (matchesKey(data, Key.down)) {
      this.moveSelection(1);

      return;
    }

    if (matchesKey(data, Key.enter)) {
      const selected = this.getSelectedChoice();

      if (selected) {
        const name = selected.skill.name;
        this.desired.set(name, !(this.desired.get(name) ?? selected.modelEnabled));
        this.tui.requestRender();
      }

      return;
    }

    if (matchesKey(data, Key.backspace)) {
      if (this.search.length > 0) {
        this.search = Array.from(this.search).slice(0, -1).join("");
        this.selectedIndex = 0;
        this.tui.requestRender();
      }

      return;
    }

    if (isPrintableInput(data)) {
      this.search += data;
      this.selectedIndex = 0;
      this.tui.requestRender();
    }
  }

  render(width: number): string[] {
    const innerWidth = Math.max(20, width - 2);
    const panelHeight = this.getPanelHeight();
    const bodyHeight = Math.max(10, panelHeight - 8);
    const leftWidth = Math.max(32, Math.floor((innerWidth - 1) * 0.48));
    const rightWidth = Math.max(28, innerWidth - leftWidth - 1);

    const header = this.renderHeader(innerWidth);

    const search = frameLine(
      this.theme,
      this.theme.fg("muted", `Search: ${this.search || "(type to filter)"}`),
      innerWidth,
    );

    const body = combineColumns(
      this.renderList(leftWidth, bodyHeight),
      this.renderDetails(rightWidth, bodyHeight),
      leftWidth,
      rightWidth,
      this.theme.fg("borderMuted", "│"),
    ).map((line) => frameLine(this.theme, line, innerWidth));

    const footer = [
      frameLine(
        this.theme,
        this.theme.fg("dim", "type search • ↑↓ move • enter toggle • ctrl+s save"),
        innerWidth,
      ),
      frameLine(
        this.theme,
        this.theme.fg("dim", "checked = visible to model • esc cancel"),
        innerWidth,
      ),
    ];

    return [
      topBorder(this.theme, innerWidth),
      frameLine(this.theme, header, innerWidth),
      search,
      divider(this.theme, innerWidth),
      ...body,
      divider(this.theme, innerWidth),
      ...footer,
      bottomBorder(this.theme, innerWidth),
    ];
  }

  invalidate(): void {}

  private renderHeader(innerWidth: number): string {
    const title = this.theme.fg("accent", this.theme.bold("Pi Skill Toggle"));
    const changed = Object.keys(this.getChanges()).length;
    const summary = this.theme.fg("muted", `${this.choices.length} skills • ${changed} changed`);
    const gap = Math.max(1, innerWidth - visibleWidth(title) - visibleWidth(summary));

    return `${title}${" ".repeat(gap)}${summary}`;
  }

  private renderList(width: number, height: number): string[] {
    const lines: string[] = [];
    const filtered = this.getFilteredChoices();

    if (filtered.length === 0) {
      lines.push(this.theme.fg("dim", "No matching skills"));

      return pad(lines, height);
    }

    this.selectedIndex = clamp(this.selectedIndex, 0, filtered.length - 1);
    const visibleCount = Math.max(4, Math.floor(height / 2));

    const start = Math.max(
      0,
      Math.min(
        this.selectedIndex - Math.floor(visibleCount / 2),
        Math.max(0, filtered.length - visibleCount),
      ),
    );

    const end = Math.min(filtered.length, start + visibleCount);

    for (let i = start; i < end; i += 1) {
      const choice = filtered[i];

      if (!choice) continue;
      const desired = this.desired.get(choice.skill.name) ?? choice.modelEnabled;
      const selected = i === this.selectedIndex;
      const changed = desired !== choice.modelEnabled;
      const marker = selected ? "›" : " ";
      const box = desired ? "◼" : "□";
      const changedMark = changed ? this.theme.fg("accent", " *") : "";
      const label = `${marker} ${box} ${choice.skill.name}${changedMark}`;
      lines.push(
        selected ? this.theme.fg("accent", this.theme.bold(fit(label, width))) : fit(label, width),
      );
      lines.push(
        this.theme.fg(
          "dim",
          fit(`    ${modeLabel(desired)} — ${shorten(choice.skill.description, width - 4)}`, width),
        ),
      );
    }

    return pad(lines, height);
  }

  private renderDetails(width: number, height: number): string[] {
    const choice = this.getSelectedChoice();
    const lines: string[] = [];

    if (!choice) {
      lines.push(this.theme.fg("dim", "No skill selected"));

      return pad(lines, height);
    }

    const { skill } = choice;
    const desired = this.desired.get(skill.name) ?? choice.modelEnabled;
    const sourceDefault = !skill.disableModelInvocation;
    lines.push(this.theme.fg("accent", this.theme.bold(skill.name)));
    lines.push("");
    lines.push(`${this.theme.fg("muted", "Current:")} ${modeLabel(choice.modelEnabled)}`);
    lines.push(
      `${this.theme.fg("muted", "Desired:")} ${modeLabel(desired)}${desired !== choice.modelEnabled ? this.theme.fg("accent", " (changed)") : ""}`,
    );
    lines.push(`${this.theme.fg("muted", "Skill default:")} ${modeLabel(sourceDefault)}`);
    lines.push(`${this.theme.fg("muted", "Scope:")} ${skill.sourceInfo.scope}`);
    lines.push(`${this.theme.fg("muted", "Source:")} ${skill.sourceInfo.source}`);
    lines.push("");
    lines.push(this.theme.fg("muted", "Repository:"));
    lines.push(...wrap(this.repository, width));
    lines.push("");
    lines.push(this.theme.fg("muted", "Path:"));
    lines.push(...wrap(skill.filePath, width));
    lines.push("");
    lines.push(this.theme.fg("muted", "Description:"));
    lines.push(...wrap(skill.description, width));

    return pad(lines, height);
  }

  private moveSelection(delta: number): void {
    const filtered = this.getFilteredChoices();

    if (filtered.length === 0) return;
    this.selectedIndex = clamp(this.selectedIndex + delta, 0, filtered.length - 1);
    this.tui.requestRender();
  }

  private getFilteredChoices(): SkillChoice[] {
    return filterSkills(this.choices, this.search);
  }

  private getSelectedChoice(): SkillChoice | undefined {
    return this.getFilteredChoices()[this.selectedIndex];
  }

  private getChanges() {
    const changes: Record<string, boolean> = {};

    for (const choice of this.choices) {
      const desired = this.desired.get(choice.skill.name) ?? choice.modelEnabled;

      if (desired !== choice.modelEnabled) changes[choice.skill.name] = desired;
    }

    return changes;
  }

  private getPanelHeight(): number {
    const rows = this.tui.terminal.rows ?? 30;

    return clamp(Math.floor(rows * 0.82), 16, 52);
  }
}

function isPrintableInput(data: string): boolean {
  return (
    data.length > 0 &&
    !data.includes("\x1b") &&
    !data.includes("\r") &&
    !data.includes("\n") &&
    data >= " "
  );
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function pad(lines: string[], height: number): string[] {
  const padded = [...lines];

  while (padded.length < height) padded.push("");

  return padded.slice(0, height);
}

function shorten(text: string, width: number): string {
  return text.length <= width ? text : `${text.slice(0, Math.max(0, width - 1))}…`;
}

function wrap(text: string, width: number): string[] {
  const words = text.split(/\s+/).filter(Boolean);

  if (words.length === 0) return [""];
  const lines: string[] = [];
  let current = "";

  for (const word of words) {
    if (current.length === 0) {
      current = word;
    } else if (`${current} ${word}`.length <= width) {
      current = `${current} ${word}`;
    } else {
      lines.push(current);
      current = word;
    }
  }

  if (current) lines.push(current);

  return lines;
}
