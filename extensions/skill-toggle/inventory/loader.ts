import { dirname } from "node:path";
import type { SkillLocator } from "../discovery/skill-locator";
import type { FrontmatterCodec } from "../frontmatter/parser";
import { deriveSkillMetadata } from "../frontmatter/validation";
import type { FileSystem } from "../ports/fs";
import type { SkillRecord } from "../types";
import { classifyInvocationMode } from "./classifier";

export interface SkillInventory {
  load(cwd: string): Promise<SkillRecord[]>;
}

export class DefaultSkillInventory implements SkillInventory {
  constructor(
    private readonly locator: SkillLocator,
    private readonly fs: FileSystem,
    private readonly codec: FrontmatterCodec,
  ) {}

  async load(cwd: string): Promise<SkillRecord[]> {
    const located = await this.locator.findSkillFiles(cwd);
    const records: SkillRecord[] = [];

    for (const file of located) {
      try {
        const raw = await this.fs.readFile(file.filePath);
        const doc = this.codec.parse(raw);
        const metadata = deriveSkillMetadata(file.filePath, doc);
        records.push({
          id: file.filePath,
          name: metadata.name,
          description: metadata.description,
          filePath: file.filePath,
          baseDir: dirname(file.filePath),
          source: file.source,
          editable:
            file.editable &&
            doc.hasFrontmatter &&
            !metadata.diagnostics.some((d) => d.severity === "error"),
          mode: classifyInvocationMode(doc),
          diagnostics: metadata.diagnostics,
        });
      } catch (error) {
        records.push({
          id: file.filePath,
          name: file.filePath.split("/").at(-2) ?? file.filePath,
          description: "",
          filePath: file.filePath,
          baseDir: dirname(file.filePath),
          source: file.source,
          editable: false,
          mode: "agent-invocable",
          diagnostics: [
            { severity: "error", message: error instanceof Error ? error.message : String(error) },
          ],
        });
      }
    }

    return records.sort(
      (a, b) => a.name.localeCompare(b.name) || a.filePath.localeCompare(b.filePath),
    );
  }
}
