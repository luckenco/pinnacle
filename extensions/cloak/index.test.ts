import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { cloakText, loadState } from "./index";

const state = loadState();

describe("cloak", () => {
  it("masks env values", () => {
    const result = cloakText("API_KEY=secret", ".env", "/repo", state);

    assert.equal(result, "API_KEY=******");
  });

  it("masks auth tokens", () => {
    const result = cloakText('{"apiKey":"secret"}', "~/.pi/agent/auth.json", "/repo", state);

    assert.equal(result.includes("secret"), false);
    assert.equal(result.includes("*"), true);
  });

  it("leaves unrelated files unchanged", () => {
    const input = "API_KEY=secret";

    assert.equal(cloakText(input, "README.md", "/repo", state), input);
  });

  it("rejects malformed config rather than loading partially valid rules", () => {
    const path = join(mkdtempSync(join(tmpdir(), "cloak-")), "cloak.json");
    writeFileSync(path, JSON.stringify({ patterns: [{ filePattern: ".env", cloakPattern: 42 }] }));

    const invalid = loadState(path);
    assert.match(invalid.error ?? "", /invalid pi-cloak config/);
    assert.equal(invalid.rules.length, 0);
    assert.equal(cloakText("API_KEY=secret", ".env", "/repo", invalid), "API_KEY=secret");
  });
});
