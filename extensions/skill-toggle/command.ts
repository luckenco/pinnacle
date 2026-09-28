import type { ExtensionCommandContext, Skill } from "@earendil-works/pi-coding-agent";
import { findRepositoryRoot } from "./repository";
import { applyChanges, effectiveModelEnabled, type SkillToggleStore } from "./state";
import type { SkillChoice } from "./types";
import { showSkillToggleUi } from "./ui/overlay";

export async function runToggleSkillsCommand(
  ctx: ExtensionCommandContext,
  store: SkillToggleStore,
): Promise<void> {
  if (ctx.mode !== "tui") {
    ctx.ui.notify("/toggle-skills requires terminal interactive mode", "error");
    return;
  }

  const skills = ctx.getSystemPromptOptions().skills ?? [];
  if (skills.length === 0) {
    ctx.ui.notify("Pi Skill Toggle: no loaded skills", "info");
    return;
  }

  let repository: string;
  let choices: SkillChoice[];
  try {
    repository = await findRepositoryRoot(ctx.cwd);
    const state = await store.load(repository);
    choices = skills.map((skill) => ({
      skill,
      modelEnabled: effectiveModelEnabled(skill, state.overrides),
    }));
  } catch (error) {
    ctx.ui.notify(`Pi Skill Toggle: ${message(error)}`, "error");
    return;
  }

  const result = await showSkillToggleUi(ctx, repository, choices);
  if (result.action !== "apply") return;

  const changed = Object.entries(result.changes);
  if (changed.length === 0) {
    ctx.ui.notify("Pi Skill Toggle: no changes to save", "info");
    return;
  }

  try {
    await store.update(repository, (state) => applyChanges(state, skills, result.changes));
  } catch (error) {
    ctx.ui.notify(`Pi Skill Toggle could not save: ${message(error)}`, "error");
    return;
  }

  ctx.ui.notify(formatResult(changed, skills), "info");
}

function formatResult(changed: Array<[string, boolean]>, skills: Skill[]): string {
  const skillNames = new Set(skills.map((skill) => skill.name));
  const applied = changed.filter(([name]) => skillNames.has(name));
  const lines = [
    `Pi Skill Toggle updated ${applied.length} skill${applied.length === 1 ? "" : "s"} for this repository.`,
  ];
  for (const [name, enabled] of applied.slice(0, 6)) {
    lines.push(`- ${name}: ${enabled ? "model-visible" : "manual-only"}`);
  }
  if (applied.length > 6) lines.push(`- … ${applied.length - 6} more`);
  lines.push("Applies on the next model turn; /skill:<name> remains available.");
  return lines.join("\n");
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
