import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import * as piAi from "@earendil-works/pi-ai";
import {
  type Context,
  clampThinkingLevel,
  type Model,
  type SimpleStreamOptions,
} from "@earendil-works/pi-ai";
import {
  type ExtensionAPI,
  type ExtensionContext,
  getAgentDir,
} from "@earendil-works/pi-coding-agent";

const {
  streamOpenAICodexResponses: streamCodex,
  streamSimpleOpenAICodexResponses: streamSimpleCodex,
} = piAi as typeof import("@earendil-works/pi-ai/compat");
const STATUS_KEY = "codex-fast";
export const FAST_MODELS = new Set(["gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna"]);
type CodexModel = Model<"openai-codex-responses">;
type CodexStreamers = { full: typeof streamCodex; simple: typeof streamSimpleCodex };

export function isFastModel(model: Pick<Model<string>, "provider" | "id"> | undefined): boolean {
  return model?.provider === "openai-codex" && FAST_MODELS.has(model.id);
}

const configPath = (agentDir: string) => join(agentDir, "extensions", "codex-fast.json");

export function loadFastMode(agentDir: string): boolean {
  try {
    const value: unknown = JSON.parse(readFileSync(configPath(agentDir), "utf8"));
    return Boolean(
      value && typeof value === "object" && "enabled" in value && value.enabled === true,
    );
  } catch {
    return false;
  }
}

function saveFastMode(agentDir: string, enabled: boolean): void {
  const path = configPath(agentDir);
  mkdirSync(join(agentDir, "extensions"), { recursive: true });
  writeFileSync(path, `${JSON.stringify({ enabled }, null, 2)}\n`, "utf8");
}

export function routeCodex(
  model: CodexModel,
  context: Context,
  options: SimpleStreamOptions | undefined,
  enabled: boolean,
  streamers: CodexStreamers = { full: streamCodex, simple: streamSimpleCodex },
) {
  if (!enabled || !isFastModel(model)) return streamers.simple(model, context, options);
  const effort = options?.reasoning ? clampThinkingLevel(model, options.reasoning) : undefined;
  return streamers.full(model, context, {
    ...options,
    reasoningEffort: effort === "off" ? undefined : effort,
    serviceTier: "priority",
  });
}

export default function codexFast(pi: ExtensionAPI) {
  const agentDir = getAgentDir();
  let enabled = loadFastMode(agentDir);

  const syncStatus = (ctx: ExtensionContext) => {
    if (!ctx.hasUI) return;
    const status =
      enabled && isFastModel(ctx.model) ? ctx.ui.theme.fg("accent", "⚡ Fast") : undefined;
    ctx.ui.setStatus(STATUS_KEY, status);
  };

  pi.registerProvider("openai-codex", {
    api: "openai-codex-responses",
    streamSimple: (model, context, options) =>
      routeCodex(model as CodexModel, context, options, enabled),
  });

  pi.on("session_start", (_event, ctx) => syncStatus(ctx));
  pi.on("model_select", (_event, ctx) => syncStatus(ctx));
  pi.on("session_shutdown", (_event, ctx) => ctx.ui.setStatus(STATUS_KEY, undefined));

  pi.registerCommand("fast", {
    description: "Enable or disable Codex Fast Mode",
    handler: async (args, ctx) => {
      const action = args.trim().toLowerCase();
      if (action !== "" && action !== "on" && action !== "off") {
        ctx.ui.notify("Usage: /fast [on|off]", "warning");
        return;
      }
      enabled = action === "on" || (action === "" && !enabled);
      saveFastMode(agentDir, enabled);
      syncStatus(ctx);
      ctx.ui.notify(`Fast Mode ${enabled ? "enabled" : "disabled"}`, "info");
    },
  });
}
