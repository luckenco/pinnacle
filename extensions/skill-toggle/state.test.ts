import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, it } from "node:test";
import { formatSkillsForPrompt, type Skill } from "@earendil-works/pi-coding-agent";
import {
  applyChanges,
  applySkillOverrides,
  effectiveModelEnabled,
  SkillToggleStore,
} from "./state";
import type { SkillToggleState } from "./types";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => fs.rm(path, { recursive: true })));
});

describe("skill toggle state", () => {
  it("changes model visibility without mutating loaded skills", () => {
    const visible = skill("visible", false);
    const manual = skill("manual", true);
    const loaded = [visible, manual];

    const overridden = applySkillOverrides(loaded, { visible: false, manual: true });

    assert.equal(overridden[0]?.disableModelInvocation, true);
    assert.equal(overridden[1]?.disableModelInvocation, false);
    assert.equal(visible.disableModelInvocation, false);
    assert.equal(manual.disableModelInvocation, true);
    assert.equal(loaded.length, 2);
    assert.doesNotMatch(formatSkillsForPrompt(overridden), /<name>visible<\/name>/);
    assert.match(formatSkillsForPrompt(overridden), /<name>manual<\/name>/);
  });

  it("stores only choices that differ from each skill's default", () => {
    const visible = skill("visible", false);
    const manual = skill("manual", true);

    const state: SkillToggleState = {
      version: 1,
      repository: "/repo",
      overrides: { stale: false, visible: false },
    };

    const next = applyChanges(state, [visible, manual], { visible: true, manual: true });

    assert.deepEqual(next.overrides, { stale: false, manual: true });
    assert.equal(effectiveModelEnabled(visible, next.overrides), true);
    assert.equal(effectiveModelEnabled(manual, next.overrides), true);
  });

  it("keeps state separate for each repository", async () => {
    const agentDir = await makeTemporaryDirectory();
    const store = new SkillToggleStore(agentDir);

    await store.update("/repo/a", (state) => ({ ...state, overrides: { github: false } }));
    await store.update("/repo/b", (state) => ({ ...state, overrides: { postgres: false } }));

    assert.notEqual(store.path("/repo/a"), store.path("/repo/b"));
    assert.deepEqual((await store.load("/repo/a")).overrides, { github: false });
    assert.deepEqual((await store.load("/repo/b")).overrides, { postgres: false });
  });

  it("rejects malformed persisted state", async () => {
    const agentDir = await makeTemporaryDirectory();
    const store = new SkillToggleStore(agentDir);
    const path = store.path("/repo");
    await fs.mkdir(dirname(path), { recursive: true });

    const invalid = [
      [[], /state must be an object/],
      [{ version: 2 }, /unsupported skill toggle state version/],
      [{ version: 1, repository: "/other" }, /repository mismatch/],
      [{ version: 1, repository: "/repo", overrides: [] }, /overrides must be an object/],
      [
        { version: 1, repository: "/repo", overrides: { github: "no" } },
        /map skill names to booleans/,
      ],
      [{ version: 1, repository: "/repo", overrides: { "": true } }, /map skill names to booleans/],
    ] as const;

    for (const [value, message] of invalid) {
      await fs.writeFile(path, JSON.stringify(value));
      await assert.rejects(store.load("/repo"), message);
    }
  });

  it("does not overwrite a state file locked by another Pi session", async () => {
    const agentDir = await makeTemporaryDirectory();
    const store = new SkillToggleStore(agentDir);
    const path = store.path("/repo");
    await fs.mkdir(dirname(path), { recursive: true });
    await fs.writeFile(`${path}.lock`, "");

    await assert.rejects(
      store.update("/repo", (state) => ({ ...state, overrides: { github: false } })),
      /another Pi session/,
    );
    assert.equal(await fs.readFile(`${path}.lock`, "utf8"), "");
  });
});

function skill(name: string, disableModelInvocation: boolean): Skill {
  return {
    name,
    description: `${name} description`,
    filePath: `/skills/${name}/SKILL.md`,
    baseDir: `/skills/${name}`,
    disableModelInvocation,
    sourceInfo: {
      path: `/skills/${name}/SKILL.md`,
      source: "test",
      scope: "project",
      origin: "top-level",
    },
  };
}

async function makeTemporaryDirectory(): Promise<string> {
  const path = await fs.mkdtemp(join(os.tmpdir(), "pinnacle-skill-toggle-"));
  temporaryDirectories.push(path);

  return path;
}
