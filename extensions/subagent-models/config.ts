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
import { Type } from "typebox";
import { Value } from "typebox/value";

export type SubagentModels = {
  eye: string[];
  hand: string | null;
  reasoning: { eye: Record<string, ModelThinkingLevel>; hand: ModelThinkingLevel | null };
};

export function missingAssignments(config: SubagentModels): ("eye" | "hand")[] {
  const missing: ("eye" | "hand")[] = [];

  if (config.eye.length === 0) missing.push("eye");

  if (config.hand === null) missing.push("hand");

  return missing;
}

const level = Type.Union([
  Type.Literal("off"),
  Type.Literal("minimal"),
  Type.Literal("low"),
  Type.Literal("medium"),
  Type.Literal("high"),
  Type.Literal("xhigh"),
  Type.Literal("max"),
]);

const id = Type.String({ pattern: "^[^/]+/[\\s\\S]+$" });

const assignments = Type.Object(
  {
    eye: Type.Array(id, { uniqueItems: true }),
    hand: Type.Union([id, Type.Null()]),
    reasoning: Type.Unknown(),
  },
  { additionalProperties: false },
);

const reasoningConfig = Type.Object(
  { eye: Type.Record(Type.String(), level), hand: Type.Union([level, Type.Null()]) },
  { additionalProperties: false },
);

const errno = Type.Object({ code: Type.String() });

function read(path: string): string | null {
  try {
    return readFileSync(path, "utf8");
  } catch (error) {
    if (Value.Check(errno, error) && error.code === "ENOENT") return null;
    throw error;
  }
}

type LoadedConfig = { config: SubagentModels; raw: string | null };

export function loadConfig(path: string): LoadedConfig {
  const raw = read(path);

  if (raw === null) {
    return { config: { eye: [], hand: null, reasoning: { eye: {}, hand: null } }, raw };
  }

  const value: unknown = JSON.parse(raw);

  if (!Value.Check(assignments, value)) {
    throw new Error(`Invalid config at ${path}: expected unique eye IDs and one hand ID or null`);
  }

  const reasoning = value.reasoning;

  if (
    !Value.Check(reasoningConfig, reasoning) ||
    Object.keys(reasoning.eye).some((id) => !value.eye.includes(id)) ||
    value.eye.some((id) => !Object.hasOwn(reasoning.eye, id)) ||
    (value.hand === null ? reasoning.hand !== null : reasoning.hand === null)
  ) {
    throw new Error(`Invalid reasoning configuration at ${path}`);
  }

  const config: SubagentModels = {
    eye: value.eye,
    hand: value.hand,
    reasoning: { eye: reasoning.eye, hand: reasoning.hand },
  };

  return { config, raw };
}

export function saveConfig(path: string, baseline: string | null, config: SubagentModels): void {
  const missing = missingAssignments(config);

  if (missing.length) {
    throw new Error(
      `Subagent models require at least one eye and one hand (${missing.join(", ")} missing)`,
    );
  }

  mkdirSync(dirname(path), { recursive: true });
  const lockPath = `${path}.lock`;
  let lock: number;

  try {
    lock = openSync(lockPath, "wx", 0o600);
  } catch (error) {
    if (Value.Check(errno, error) && error.code === "EEXIST") {
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
