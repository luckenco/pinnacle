import type { Skill } from "@earendil-works/pi-coding-agent";

export interface SkillChoice {
  skill: Skill;
  modelEnabled: boolean;
}

export interface SkillToggleUiResult {
  action: "apply" | "cancel";
  changes: Record<string, boolean>;
}

export interface SkillToggleState {
  version: 1;
  repository: string;
  overrides: Record<string, boolean>;
}
