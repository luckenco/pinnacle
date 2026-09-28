import type { SkillChoice } from "../types";

export function modeLabel(enabled: boolean): string {
  return enabled ? "Model-visible" : "Manual-only";
}

export function skillSearchText(choice: SkillChoice): string {
  const { skill } = choice;
  return [
    skill.name,
    skill.description,
    skill.filePath,
    skill.sourceInfo.source,
    skill.sourceInfo.scope,
    skill.sourceInfo.origin,
  ]
    .join(" ")
    .toLowerCase();
}

export function filterSkills(choices: SkillChoice[], query: string): SkillChoice[] {
  const tokens = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return choices;
  return choices.filter((choice) => {
    const haystack = skillSearchText(choice);
    return tokens.every((token) => haystack.includes(token));
  });
}
