import { randomUUID } from "node:crypto";
import {
  closeSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname } from "node:path";
import type { ModelThinkingLevel } from "@earendil-works/pi-ai";

export type SubagentModels = {
  eye: string[];
  hand: string | null;
  reasoning: { eye: Record<string, ModelThinkingLevel>; hand: ModelThinkingLevel | null };
};

const levels = new Set<ModelThinkingLevel>([
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
]);

function isLevel(value: unknown): value is ModelThinkingLevel {
  return typeof value === "string" && levels.has(value as ModelThinkingLevel);
}

function read(path: string): string | null {
  try {
    return readFileSync(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

function modelId(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const slash = value.indexOf("/");
  return slash > 0 && slash < value.length - 1;
}

export function loadConfig(path: string): { config: SubagentModels; raw: string | null } {
  const raw = read(path);
  if (raw === null) {
    return { config: { eye: [], hand: null, reasoning: { eye: {}, hand: null } }, raw };
  }
  const value = JSON.parse(raw);
  if (
    !value ||
    typeof value !== "object" ||
    Object.keys(value).some((key) => key !== "eye" && key !== "hand" && key !== "reasoning") ||
    !Array.isArray(value.eye) ||
    !value.eye.every(modelId) ||
    new Set(value.eye).size !== value.eye.length ||
    !(value.hand === null || modelId(value.hand))
  ) {
    throw new Error(`Invalid config at ${path}: expected unique eye IDs and one hand ID or null`);
  }
  const reasoning = value.reasoning;
  if (
    !reasoning ||
    typeof reasoning !== "object" ||
    Array.isArray(reasoning) ||
    Object.keys(reasoning).some((key) => key !== "eye" && key !== "hand") ||
    !reasoning.eye ||
    typeof reasoning.eye !== "object" ||
    Array.isArray(reasoning.eye) ||
    Object.entries(reasoning.eye).some(
      ([id, level]) => !value.eye.includes(id) || !isLevel(level),
    ) ||
    value.eye.some((id: string) => !Object.hasOwn(reasoning.eye, id)) ||
    (value.hand === null ? reasoning.hand !== null : !isLevel(reasoning.hand))
  ) {
    throw new Error(`Invalid reasoning configuration at ${path}`);
  }
  return {
    config: {
      eye: value.eye,
      hand: value.hand,
      reasoning: { eye: reasoning.eye, hand: reasoning.hand },
    },
    raw,
  };
}

export function saveConfig(path: string, baseline: string | null, config: SubagentModels): void {
  mkdirSync(dirname(path), { recursive: true });
  const lockPath = `${path}.lock`;
  let lock: number;
  try {
    lock = openSync(lockPath, "wx", 0o600);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      throw new Error(`Config is locked: ${lockPath}. Reopen after the other writer finishes.`);
    }
    throw error;
  }
  const temp = `${path}.${randomUUID()}.tmp`;
  try {
    if (read(path) !== baseline) {
      throw new Error("Config changed in another session. Reopen /subagent-models; nothing saved.");
    }
    writeFileSync(temp, `${JSON.stringify(config, null, 2)}\n`, { flag: "wx", mode: 0o600 });
    renameSync(temp, path);
  } finally {
    rmSync(temp, { force: true });
    closeSync(lock);
    rmSync(lockPath);
  }
}
