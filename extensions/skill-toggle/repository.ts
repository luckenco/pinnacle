import fs from "node:fs/promises";
import { dirname, join, parse, resolve } from "node:path";

export async function findRepositoryRoot(cwd: string): Promise<string> {
  const startingDirectory = await fs.realpath(resolve(cwd));
  const filesystemRoot = parse(startingDirectory).root;
  let current = startingDirectory;

  while (true) {
    if ((await exists(join(current, ".jj"))) || (await exists(join(current, ".git")))) {
      return current;
    }

    if (current === filesystemRoot) return startingDirectory;
    current = dirname(current);
  }
}

async function exists(path: string): Promise<boolean> {
  try {
    await fs.access(path);

    return true;
  } catch {
    return false;
  }
}
