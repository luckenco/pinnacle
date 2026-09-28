import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import { findRepositoryRoot } from "./repository";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => fs.rm(path, { recursive: true })));
});

describe("findRepositoryRoot", () => {
  it("uses the nearest Jujutsu or Git root", async () => {
    const root = await makeTemporaryDirectory();
    const nested = join(root, "src", "feature");
    await fs.mkdir(join(root, ".jj"));
    await fs.mkdir(nested, { recursive: true });

    assert.equal(await findRepositoryRoot(nested), root);
  });

  it("uses the working directory outside a repository", async () => {
    const cwd = await makeTemporaryDirectory();

    assert.equal(await findRepositoryRoot(cwd), cwd);
  });
});

async function makeTemporaryDirectory(): Promise<string> {
  const path = await fs.realpath(
    await fs.mkdtemp(join(os.tmpdir(), "pinnacle-skill-toggle-repo-")),
  );

  temporaryDirectories.push(path);

  return path;
}
