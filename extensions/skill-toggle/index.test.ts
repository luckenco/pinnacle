import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import type { ExtensionAPI, Skill } from "@earendil-works/pi-coding-agent";
import extension from "./index";
import { SkillToggleStore } from "./state";

const root = await fs.realpath(await fs.mkdtemp(join(os.tmpdir(), "pinnacle-skill-toggle-index-")));
const repository = join(root, "repository");
const agentDir = join(root, "agent");
await fs.mkdir(join(repository, ".git"), { recursive: true });

after(async () => {
  await fs.rm(root, { recursive: true });
});

test("registers the command and applies repository overrides before a model turn", async () => {
  let beforeAgentStart:
    | ((
        event: { systemPromptOptions: { skills: Skill[] } },
        ctx: { cwd: string; ui: { notify(): void } },
      ) => Promise<void>)
    | undefined;
  let commandName = "";
  extension(
    {
      on: (name: string, handler: unknown) => {
        if (name === "before_agent_start") beforeAgentStart = handler as typeof beforeAgentStart;
        return () => {};
      },
      registerCommand: (name: string) => {
        commandName = name;
      },
    } as unknown as ExtensionAPI,
    agentDir,
  );

  const store = new SkillToggleStore(agentDir);
  await store.update(repository, (state) => ({ ...state, overrides: { github: false } }));
  const github = skill("github");
  const event = { systemPromptOptions: { skills: [github] } };

  await beforeAgentStart?.(event, { cwd: repository, ui: { notify() {} } });

  assert.equal(commandName, "toggle-skills");
  assert.equal(event.systemPromptOptions.skills[0]?.disableModelInvocation, true);
  assert.equal(github.disableModelInvocation, false);
});

function skill(name: string): Skill {
  const filePath = `/skills/${name}/SKILL.md`;
  return {
    name,
    description: `${name} description`,
    filePath,
    baseDir: `/skills/${name}`,
    disableModelInvocation: false,
    sourceInfo: {
      path: filePath,
      source: "test",
      scope: "project",
      origin: "top-level",
    },
  };
}
