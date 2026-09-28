import { createHash, randomUUID } from "node:crypto";
import fs, { type FileHandle } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { Skill } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { Value } from "typebox/value";
import type { SkillToggleState } from "./types";

const object = Type.Object({});

const version = Type.Object({ version: Type.Literal(1) });

const overrides = Type.Object({ overrides: Type.Record(Type.String(), Type.Boolean()) });

const errno = Type.Object({ code: Type.String() });

export class SkillToggleStore {
  constructor(private readonly agentDir: string) {}

  async load(repository: string): Promise<SkillToggleState> {
    const path = this.path(repository);
    let raw: string;

    try {
      raw = await fs.readFile(path, "utf8");
    } catch (error) {
      if (error instanceof Error && Value.Check(errno, error) && error.code === "ENOENT")
        return emptyState(repository);
      throw error;
    }

    return parseState(raw, repository);
  }

  async update(
    repository: string,
    update: (state: SkillToggleState) => SkillToggleState,
  ): Promise<SkillToggleState> {
    const path = this.path(repository);
    await fs.mkdir(dirname(path), { recursive: true });
    const lockPath = `${path}.lock`;
    let lock: FileHandle;

    try {
      lock = await fs.open(lockPath, "wx", 0o600);
    } catch (error) {
      if (error instanceof Error && Value.Check(errno, error) && error.code === "EEXIST") {
        throw new Error(
          "skill toggle state is being changed by another Pi session; reopen the picker",
        );
      }

      throw error;
    }

    try {
      const next = update(await this.load(repository));
      validateState(next, repository);
      await writeAtomic(path, `${JSON.stringify(next, null, 2)}\n`);

      return next;
    } finally {
      try {
        await lock.close();
      } finally {
        await fs.rm(lockPath, { force: true });
      }
    }
  }

  path(repository: string): string {
    const id = createHash("sha256").update(repository).digest("hex");

    return join(this.agentDir, "skill-toggle", `${id}.json`);
  }
}

export function applySkillOverrides(skills: Skill[], overrides: Record<string, boolean>): Skill[] {
  return skills.map((skill) => {
    const enabled = overrides[skill.name];

    if (enabled === undefined) return skill;

    return { ...skill, disableModelInvocation: !enabled };
  });
}

export function effectiveModelEnabled(skill: Skill, overrides: Record<string, boolean>): boolean {
  return overrides[skill.name] ?? !skill.disableModelInvocation;
}

export function applyChanges(
  state: SkillToggleState,
  skills: Skill[],
  changes: Record<string, boolean>,
): SkillToggleState {
  const overrides = { ...state.overrides };
  const skillByName = new Map(skills.map((skill) => [skill.name, skill]));

  for (const [name, enabled] of Object.entries(changes)) {
    const skill = skillByName.get(name);

    if (!skill) continue;

    if (enabled === !skill.disableModelInvocation) {
      delete overrides[name];
    } else {
      overrides[name] = enabled;
    }
  }

  return { ...state, overrides };
}

function emptyState(repository: string): SkillToggleState {
  return { version: 1, repository, overrides: {} };
}

function parseState(raw: string, repository: string): SkillToggleState {
  const parsed: unknown = JSON.parse(raw);
  validateState(parsed, repository);

  return parsed;
}

function validateState(value: unknown, repository: string): asserts value is SkillToggleState {
  if (!Value.Check(object, value)) throw new Error("skill toggle state must be an object");

  if (!Value.Check(version, value)) throw new Error("unsupported skill toggle state version");

  if (!Value.Check(Type.Object({ repository: Type.Literal(repository) }), value)) {
    throw new Error("skill toggle state repository mismatch");
  }

  if (!Value.Check(Type.Object({ overrides: object }), value)) {
    throw new Error("skill toggle overrides must be an object");
  }

  if (!Value.Check(overrides, value)) {
    throw new Error("skill toggle overrides must map skill names to booleans");
  }

  if (Object.keys(value.overrides).includes("")) {
    throw new Error("skill toggle overrides must map skill names to booleans");
  }
}

async function writeAtomic(path: string, content: string): Promise<void> {
  const temporary = `${path}.${randomUUID()}.tmp`;

  try {
    await fs.writeFile(temporary, content, { encoding: "utf8", flag: "wx", mode: 0o600 });
    await fs.rename(temporary, path);
  } finally {
    await fs.rm(temporary, { force: true });
  }
}
