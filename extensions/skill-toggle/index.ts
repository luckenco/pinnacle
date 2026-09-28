import { type ExtensionAPI, getAgentDir } from "@earendil-works/pi-coding-agent";
import { runToggleSkillsCommand } from "./command";
import { findRepositoryRoot } from "./repository";
import { applySkillOverrides, SkillToggleStore } from "./state";

export default function piSkillToggle(pi: ExtensionAPI, agentDir = getAgentDir()) {
  const store = new SkillToggleStore(agentDir);

  pi.on("before_agent_start", async (event, ctx) => {
    try {
      const repository = await findRepositoryRoot(ctx.cwd);
      const state = await store.load(repository);
      event.systemPromptOptions.skills = applySkillOverrides(
        event.systemPromptOptions.skills,
        state.overrides,
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      ctx.ui.notify(`Pi Skill Toggle: ${message}`, "warning");
    }
  });

  pi.registerCommand("toggle-skills", {
    description: "Choose which loaded skills are visible to the model in this repository",
    handler: async (_args, ctx) => {
      await runToggleSkillsCommand(ctx, store);
    },
  });
}
