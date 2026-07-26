import assert from "node:assert/strict";
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
});
