import { join } from "node:path";
import type { Api, Model } from "@earendil-works/pi-ai";
import {
  type ExtensionAPI,
  type ExtensionCommandContext,
  getAgentDir,
} from "@earendil-works/pi-coding-agent";
import { loadConfig, missingAssignments, type SubagentModels, saveConfig } from "./config";
import { ModelPicker } from "./picker";

export async function configure(ctx: ExtensionCommandContext, path: string): Promise<void> {
  if (ctx.mode !== "tui") {
    ctx.ui.notify("/subagent-models requires TUI mode", "error");

    return;
  }

  try {
    const { config, raw } = loadConfig(path);
    let available: Model<Api>[] | null = null;

    try {
      const result = await ctx.modelRegistry.refresh({
        allowNetwork: false,
        signal: AbortSignal.timeout(15_000),
      });

      if (result.aborted) throw new Error("Model refresh timed out or was cancelled");

      if (result.errors.size) throw new Error([...result.errors.values()].map(String).join("; "));
      const error = ctx.modelRegistry.getError();

      if (error) throw new Error(error);
      available = ctx.modelRegistry.getAvailable();
    } catch (error) {
      ctx.ui.notify(`Cannot refresh models; new assignments disabled. ${String(error)}`, "warning");
    }

    const draft = await ctx.ui.custom<SubagentModels | undefined>(
      (tui, theme, keys, done) => new ModelPicker(available, config, tui, theme, keys, done),
      { overlay: true, overlayOptions: { width: "100%", maxHeight: "100%", margin: 1 } },
    );

    if (!draft) return;
    const missing = missingAssignments(draft);

    if (missing.length) {
      ctx.ui.notify(
        `Assign at least one eye and one hand before saving (${missing.join(", ")} missing).`,
        "warning",
      );

      return;
    }

    if (JSON.stringify(draft) === JSON.stringify(config)) return;
    saveConfig(path, raw, draft);
    ctx.ui.notify(`Saved subagent model preferences to ${path}.`, "info");
  } catch (error) {
    ctx.ui.notify(`Subagent models: ${String(error)}`, "error");
  }
}

function guidance(path: string): string {
  try {
    const { config } = loadConfig(path);
    const missing = missingAssignments(config);

    if (missing.length) {
      return `Subagent model roles are incomplete (${missing.join(", ")} missing). Run /subagent-models; role-based dispatch will fail until both are assigned.`;
    }

    const eyes = config.eye
      .map((id, index) => `${index + 1}. ${id} @ ${config.reasoning.eye[id]}`)
      .join("; ");

    return `Configured subagent roles: eyes in priority order: ${eyes}. Hand: ${config.hand} @ ${config.reasoning.hand}. Use the subagent task role and eyeIndex fields to apply these assignments. Use every configured eye before choosing explicit overflow models.`;
  } catch (error) {
    return `Subagent model configuration is invalid: ${String(error)}. Run /subagent-models; role-based dispatch will fail.`;
  }
}

export default function subagentModels(
  pi: ExtensionAPI,
  path = join(getAgentDir(), "extensions", "subagent-models.json"),
) {
  pi.on("session_start", (_event, ctx) => {
    if (!ctx.hasUI) return;

    try {
      const missing = missingAssignments(loadConfig(path).config);

      if (missing.length) {
        ctx.ui.notify(
          `Subagent models are not configured (${missing.join(", ")} missing). Run /subagent-models.`,
          "warning",
        );
      }
    } catch (error) {
      ctx.ui.notify(`Subagent model configuration is invalid: ${String(error)}`, "warning");
    }
  });

  pi.on("before_agent_start", (event) => {
    const sections = event.systemPromptOptions.sections;

    if (!event.systemPromptOptions.selectedTools?.includes("subagent")) {
      delete sections.subagent_models;

      return;
    }

    sections.subagent_models = guidance(path);
  });

  pi.registerCommand("subagent-models", {
    description: "Configure the eye model pool and single hand model for subagents",
    handler: async (args, ctx) => {
      if (args.trim()) {
        ctx.ui.notify("Usage: /subagent-models", "warning");

        return;
      }

      await configure(ctx, path);
    },
  });
}
