import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  clampThinkingLevel,
  InMemoryCredentialStore,
  type Model,
  type Api,
  type ApiStreamOptions,
} from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { Value } from "typebox/value";
import {
  type ExtensionAPI,
  type ExtensionContext,
  getAgentDir,
  ModelRuntime,
} from "@earendil-works/pi-coding-agent";

const STATUS_KEY = "codex-fast";

const fastModeSchema = Type.Object({ enabled: Type.Boolean() });

export function supportsFast(model: Model<Api> | undefined): model is Model<"openai-responses"> {
  return (
    model?.provider === "openai" &&
    model.api === "openai-responses" &&
    model.baseUrl === "https://api.openai.com/v1"
  );
}

function wantsPriority(
  model: Model<Api>,
  apiKey: string | undefined,
): model is Model<"openai-responses"> {
  // Match Pi's OpenAI Responses detection of Sign in with ChatGPT tokens.
  return supportsFast(model) && apiKey !== undefined && !apiKey.startsWith("sk-");
}

const configPath = (agentDir: string) => join(agentDir, "extensions", "codex-fast.json");

export function loadFastMode(agentDir: string): boolean {
  try {
    const value: unknown = JSON.parse(readFileSync(configPath(agentDir), "utf8"));

    return Value.Check(fastModeSchema, value) && value.enabled;
  } catch {
    return false;
  }
}

function saveFastMode(agentDir: string, enabled: boolean): void {
  const path = configPath(agentDir);
  mkdirSync(join(agentDir, "extensions"), { recursive: true });
  const temp = `${path}.${randomUUID()}.tmp`;

  try {
    writeFileSync(temp, `${JSON.stringify({ enabled }, null, 2)}\n`, { flag: "wx", mode: 0o600 });
    renameSync(temp, path);
  } finally {
    rmSync(temp, { force: true });
  }
}

export default async function codexFast(pi: ExtensionAPI, agentDir = getAgentDir()) {
  // Pi exposes no uncomposed builtin accessor. A config-free runtime retains its remote
  // catalog wrapper without baking old models.json overrides into our provider.
  const runtime = await ModelRuntime.create({
    modelsPath: null,
    credentials: new InMemoryCredentialStore(),
    refreshOnCreate: false,
  });

  const provider = runtime.getProvider("openai");

  if (!provider) throw new Error("OpenAI provider is unavailable");
  let enabled = loadFastMode(agentDir);

  const syncStatus = (ctx: ExtensionContext) => {
    if (!ctx.hasUI) return;

    const active = enabled && supportsFast(ctx.model) && ctx.modelRegistry.isUsingOAuth(ctx.model);

    const status = active ? ctx.ui.theme.fg("accent", "⚡ Fast") : undefined;
    ctx.ui.setStatus(STATUS_KEY, status);
  };

  pi.registerProvider({
    ...provider,
    stream(model, context, options) {
      if (!enabled || !wantsPriority(model, options?.apiKey))
        return provider.stream(model, context, options);

      // SAFETY: the API guard narrows the model; TS cannot narrow its generic options with it.
      const fastOptions = options as ApiStreamOptions<"openai-responses"> | undefined;

      return provider.stream<"openai-responses">(model, context, {
        ...fastOptions,
        serviceTier: "priority",
      });
    },
    streamSimple(model, context, options) {
      if (!enabled || !wantsPriority(model, options?.apiKey))
        return provider.streamSimple(model, context, options);

      if (!options?.apiKey) throw new Error(`No API key for provider: ${model.provider}`);
      const effort = options.reasoning ? clampThinkingLevel(model, options.reasoning) : undefined;

      // Keep the tier in options: a payload-only hook loses Pi's fallback tier pricing.
      return provider.stream<"openai-responses">(model, context, {
        ...options,
        reasoningEffort: effort === "off" ? undefined : effort,
        serviceTier: "priority",
      });
    },
  });

  pi.on("session_start", (_event, ctx) => syncStatus(ctx));
  pi.on("model_select", (_event, ctx) => syncStatus(ctx));
  pi.on("session_shutdown", (_event, ctx) => {
    pi.unregisterProvider("openai");
    ctx.ui.setStatus(STATUS_KEY, undefined);
  });

  pi.registerCommand("fast", {
    description: "Request OpenAI subscription priority service (increased usage); toggle or on/off",
    handler: async (args, ctx) => {
      const action = args.trim().toLowerCase();

      if (action !== "" && action !== "on" && action !== "off") {
        ctx.ui.notify("Usage: /fast [on|off]", "warning");

        return;
      }

      const next = action === "on" || (action === "" && !enabled);

      try {
        saveFastMode(agentDir, next);
      } catch (error) {
        ctx.ui.notify(`Could not save Fast Mode: ${String(error)}`, "error");

        return;
      }

      enabled = next;
      syncStatus(ctx);
      ctx.ui.notify(`Fast Mode ${enabled ? "enabled" : "disabled"}`, "info");
    },
  });
}
