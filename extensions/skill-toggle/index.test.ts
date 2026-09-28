import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import type { ExtensionAPI, ExtensionFactory, Skill } from "@earendil-works/pi-coding-agent";
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
  type StartHandler = (
    event: { systemPromptOptions: { skills: Skill[] } },
    ctx: { cwd: string; ui: { notify: (message: string, level: "warning") => void } },
  ) => Promise<void>;

  let beforeAgentStart: StartHandler | undefined;
  let commandName = "";

  const pi = {
    on: (_name: "before_agent_start", handler: StartHandler) => {
      beforeAgentStart = handler;

      return () => {};
    },
    registerCommand: (name: string) => {
      commandName = name;
    },
  };

  const factory = extension satisfies ExtensionFactory;
  const api: Pick<ExtensionAPI, "registerCommand"> = pi;
  // SAFETY: this test exercises only the before_agent_start and registerCommand API methods.
  factory(api as ExtensionAPI, agentDir);

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
