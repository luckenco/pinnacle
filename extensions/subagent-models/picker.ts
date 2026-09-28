import {
  type Api,
  getSupportedThinkingLevels,
  type Model,
  type ModelThinkingLevel,
} from "@earendil-works/pi-ai";
import type { KeybindingsManager, Theme } from "@earendil-works/pi-coding-agent";
import {
  type Component,
  type Focusable,
  fuzzyFilter,
  Input,
  Key,
  matchesKey,
  type TUI,
  truncateToWidth,
} from "@earendil-works/pi-tui";
import { missingAssignments, type SubagentModels } from "./config";

export class ModelPicker implements Component, Focusable {
  private input = new Input({ placeholder: "Search provider, model ID, or name" });
  private mode: "eye" | "hand" = "eye";
  private draft: SubagentModels;
  private models = new Map<string, { name: string; levels: ModelThinkingLevel[] }>();
  private catalogUnavailable: boolean;
  private ids: string[];
  private rows: string[] = [];
  private cursor = 0;
  private saveWarning: string | null = null;
  private editing: {
    id: string;
    choices: (ModelThinkingLevel | "remove")[];
    cursor: number;
  } | null = null;
  private _focused = false;

  get focused(): boolean {
    return this._focused;
  }
  set focused(value: boolean) {
    this._focused = value;
    this.input.focused = value && !this.editing;
  }

  constructor(
    available: Model<Api>[] | null,
    initial: SubagentModels,
    private tui: Pick<TUI, "terminal" | "requestRender">,
    private theme: Pick<Theme, "fg" | "bold">,
    private keys: Pick<KeybindingsManager, "matches" | "getKeys">,
    private done: (result: SubagentModels | undefined) => void,
  ) {
    this.catalogUnavailable = available === null;
    this.draft = {
      eye: [...initial.eye],
      hand: initial.hand,
      reasoning: { eye: { ...initial.reasoning.eye }, hand: initial.reasoning.hand },
    };
    for (const model of available ?? []) {
      this.models.set(`${model.provider}/${model.id}`, {
        name: model.name,
        levels: getSupportedThinkingLevels(model),
      });
    }
    this.ids = [...new Set([...this.models.keys(), ...initial.eye])];
    if (initial.hand && !this.ids.includes(initial.hand)) this.ids.push(initial.hand);
    this.ids.sort();
    this.refresh();
  }

  private get height(): number {
    return Math.max(0, this.tui.terminal.rows - 2);
  }

  private get pageSize(): number {
    return Math.min(8, Math.max(1, this.height - (this.height < 18 ? 4 : 12)));
  }

  private refresh(selected?: string): void {
    const picked = this.mode === "eye" ? this.draft.eye : this.draft.hand ? [this.draft.hand] : [];
    const ids = [...picked, ...this.ids.filter((id) => !picked.includes(id))];
    const matches = new Set(
      fuzzyFilter(ids, this.input.getValue(), (id) => `${id} ${this.models.get(id)?.name ?? ""}`),
    );
    this.rows = ids.filter((id) => matches.has(id));
    this.cursor = Math.max(0, this.rows.indexOf(selected ?? ""));
  }

  private begin(id: string): void {
    const assigned = this.mode === "eye" ? this.draft.eye.includes(id) : this.draft.hand === id;
    const choices: (ModelThinkingLevel | "remove")[] = [
      ...(this.models.get(id)?.levels ?? []),
      ...(assigned ? ["remove" as const] : []),
    ];
    if (!choices.length) return;
    const current =
      this.mode === "eye"
        ? this.draft.reasoning.eye[id]
        : this.draft.hand === id
          ? this.draft.reasoning.hand
          : null;
    const cursor = this.models.has(id) ? (current ? choices.indexOf(current) : -1) : 0;
    this.editing = { id, choices, cursor };
    this.input.focused = false;
  }

  private apply(): void {
    const editing = this.editing;
    if (!editing || editing.cursor < 0) return;
    const choice = editing.choices[editing.cursor];
    if (this.mode === "eye") {
      if (choice === "remove") {
        this.draft.eye = this.draft.eye.filter((id) => id !== editing.id);
        delete this.draft.reasoning.eye[editing.id];
      } else {
        if (!this.draft.eye.includes(editing.id)) this.draft.eye.push(editing.id);
        this.draft.reasoning.eye[editing.id] = choice;
      }
    } else if (choice === "remove") {
      this.draft.hand = null;
      this.draft.reasoning.hand = null;
    } else {
      this.draft.hand = editing.id;
      this.draft.reasoning.hand = choice;
    }
    this.editing = null;
    this.saveWarning = null;
    this.input.focused = this._focused;
    this.refresh(editing.id);
  }

  handleInput(data: string): void {
    this.tui.requestRender();
    if (this.keys.matches(data, "tui.select.cancel")) {
      if (this.editing) {
        this.editing = null;
        this.input.focused = this._focused;
      } else this.done(undefined);
      return;
    }
    if (this.height < 5) return;
    if (this.editing) {
      if (this.keys.matches(data, "tui.select.up")) {
        this.editing.cursor = Math.max(0, this.editing.cursor - 1);
      } else if (this.keys.matches(data, "tui.select.down")) {
        this.editing.cursor = Math.min(this.editing.choices.length - 1, this.editing.cursor + 1);
      } else if (this.keys.matches(data, "tui.select.confirm")) this.apply();
      return;
    }
    if (this.keys.matches(data, "app.models.save")) {
      const missing = missingAssignments(this.draft);
      if (missing.length) {
        this.saveWarning = `Cannot save · ${missing.join(" and ")} required`;
        return;
      }
      this.done({
        eye: [...this.draft.eye],
        hand: this.draft.hand,
        reasoning: { eye: { ...this.draft.reasoning.eye }, hand: this.draft.reasoning.hand },
      });
      return;
    }
    if (matchesKey(data, Key.tab)) {
      this.mode = this.mode === "eye" ? "hand" : "eye";
      this.refresh();
      return;
    }
    const id = this.rows[this.cursor];
    const up = this.keys.matches(data, "app.models.reorderUp");
    const down = this.keys.matches(data, "app.models.reorderDown");
    if (up || down) {
      if (this.mode !== "eye" || !id) return;
      const index = this.draft.eye.indexOf(id);
      const target = index + (up ? -1 : 1);
      if (index >= 0 && target >= 0 && target < this.draft.eye.length) {
        [this.draft.eye[index], this.draft.eye[target]] = [
          this.draft.eye[target],
          this.draft.eye[index],
        ];
        this.refresh(id);
      }
      return;
    }
    if (this.keys.matches(data, "tui.select.confirm")) {
      if (id) this.begin(id);
      return;
    }
    let step = 0;
    if (this.keys.matches(data, "tui.select.up")) step = -1;
    else if (this.keys.matches(data, "tui.select.down")) step = 1;
    else if (this.keys.matches(data, "tui.select.pageUp")) step = -this.pageSize;
    else if (this.keys.matches(data, "tui.select.pageDown")) step = this.pageSize;
    if (step !== 0) {
      this.cursor = Math.max(0, Math.min(this.rows.length - 1, this.cursor + step));
      return;
    }
    this.input.handleInput(data);
    this.refresh();
  }

  render(width: number): string[] {
    const theme = this.theme;
    const draft = this.draft;
    const height = this.height;
    if (height < 5) {
      return ["Enlarge terminal to edit models", "Esc to discard"]
        .slice(0, Math.max(0, height))
        .map((line) => truncateToWidth(line, width));
    }
    if (this.editing) {
      const { id, choices, cursor } = this.editing;
      const lines = [
        theme.fg("accent", theme.bold(`${this.mode.toUpperCase()} › ${id} › reasoning`)),
      ];
      const needsChoice = cursor < 0;
      if (needsChoice) {
        lines.push(
          theme.fg(
            "warning",
            `Choose a supported level (${this.keys.getKeys("tui.select.down").join("/")})`,
          ),
        );
      }
      const maxRows = Math.min(choices.length, height - 2 - (needsChoice ? 1 : 0));
      const start = Math.max(
        0,
        Math.min(cursor - Math.floor(maxRows / 2), choices.length - maxRows),
      );
      for (let i = start; i < Math.min(start + maxRows, choices.length); i++) {
        const text = `${i === cursor ? "→" : " "} ${choices[i]}`;
        lines.push(i === cursor ? theme.fg("accent", text) : text);
      }
      lines.push(
        theme.fg(
          "dim",
          `${this.keys.getKeys("tui.select.confirm").join("/")} apply · ${this.keys.getKeys("tui.select.cancel").join("/")} back`,
        ),
      );
      return lines.map((line) => truncateToWidth(line, width));
    }
    const compact = height < 18;
    const pageSize = this.pageSize;
    const unavailable = this.catalogUnavailable ? " · catalog unavailable" : "";
    const title = `Subagent models · ${this.mode.toUpperCase()}${unavailable}`;
    const lines = [
      this.saveWarning
        ? theme.fg("warning", theme.bold(`${title} · ${this.saveWarning}`))
        : theme.fg("accent", theme.bold(title)),
    ];
    if (!compact) {
      lines.push(
        theme.fg(
          "muted",
          this.catalogUnavailable
            ? "Model list unavailable; remove/reorder only."
            : "Configured roles drive subagent model and reasoning selection.",
        ),
        `Eye: ${draft.eye.length} · Primary: ${draft.eye[0] ?? "unset"}`,
        `Hand: ${draft.hand ?? "unset"}`,
        "",
      );
    }
    lines.push(...this.input.render(width));
    if (!compact) lines.push("");
    const start = Math.max(
      0,
      Math.min(this.cursor - Math.floor(pageSize / 2), this.rows.length - pageSize),
    );
    for (let index = start; index < Math.min(start + pageSize, this.rows.length); index++) {
      const id = this.rows[index];
      let mark = "·";
      if (this.mode === "eye" && draft.eye.includes(id)) mark = `${draft.eye.indexOf(id) + 1}`;
      if (this.mode === "hand" && draft.hand === id) mark = "H";
      const assigned = this.mode === "eye" ? draft.eye.includes(id) : draft.hand === id;
      const level = this.mode === "eye" ? draft.reasoning.eye[id] : draft.reasoning.hand;
      let detail = "";
      if (assigned) {
        detail = level ? ` · ${level}` : " · set reasoning";
        if (level && this.models.has(id) && !this.models.get(id)?.levels.includes(level)) {
          detail += " [unsupported]";
        }
      }
      if (!this.models.has(id) && !this.catalogUnavailable) detail += " [unavailable]";
      const text = `${mark.padStart(2)} ${id}${detail}`;
      if (index === this.cursor) lines.push(theme.fg("accent", `→ ${text}`));
      else lines.push(`  ${text}`);
    }
    if (!this.rows.length) lines.push(theme.fg("muted", "No matching models"));
    const selected = this.rows[this.cursor];
    if (!compact) {
      lines.push(
        "",
        theme.fg(
          "muted",
          selected
            ? (this.models.get(selected)?.name ??
                (this.catalogUnavailable
                  ? "Model list unavailable."
                  : "Unavailable models can only be removed."))
            : "No matching models",
        ),
        theme.fg("dim", `${this.rows.length ? this.cursor + 1 : 0}/${this.rows.length} matches`),
      );
    }
    lines.push(
      theme.fg(
        "dim",
        `${this.keys.getKeys("tui.select.confirm").join("/")} choose reasoning/remove · Tab eye/hand · ${this.keys.getKeys("app.models.reorderUp").join("/")}/${this.keys.getKeys("app.models.reorderDown").join("/")} reorder eye`,
      ),
      theme.fg(
        "dim",
        `${this.keys.getKeys("app.models.save").join("/")} save · ${this.keys.getKeys("tui.select.cancel").join("/")} discard`,
      ),
    );
    return lines.map((line) => truncateToWidth(line, width));
  }

  invalidate(): void {
    this.input.invalidate();
  }
}
