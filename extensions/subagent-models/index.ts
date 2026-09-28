import { join } from "node:path";
import type { Api, Model } from "@earendil-works/pi-ai";
import {
  type ExtensionAPI,
  type ExtensionCommandContext,
  getAgentDir,
} from "@earendil-works/pi-coding-agent";
import { loadConfig, type SubagentModels, saveConfig } from "./config";
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
    if (!draft || JSON.stringify(draft) === JSON.stringify(config)) return;
    saveConfig(path, raw, draft);
    ctx.ui.notify(`Saved subagent model preferences to ${path}. Routing is unchanged.`, "info");
  } catch (error) {
    ctx.ui.notify(`Subagent models: ${String(error)}`, "error");
  }
}

export default function subagentModels(pi: ExtensionAPI) {
  pi.registerCommand("subagent-models", {
    description: "Configure the eye model pool and single hand model (preferences only)",
    handler: async (args, ctx) => {
      if (args.trim()) {
        ctx.ui.notify("Usage: /subagent-models", "warning");
        return;
      }
      await configure(ctx, join(getAgentDir(), "extensions", "subagent-models.json"));
    },
  });
}
