import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createAssistantMessageEventStream, type Model } from "@earendil-works/pi-ai";
import { isFastModel, loadFastMode, routeCodex } from "./index";

const model = (id: string) =>
  ({
    id,
    provider: "openai-codex",
    api: "openai-codex-responses",
  }) as Model<"openai-codex-responses">;
const context = { messages: [] };

test("all GPT-5.6 models are eligible", () => {
  for (const id of ["sol", "terra", "luna"]) assert.ok(isFastModel(model(`gpt-5.6-${id}`)));
});

test("priority routing applies only when eligible and enabled", () => {
  const calls: string[] = [];
  const result = createAssistantMessageEventStream();
  const record = (call: string) => {
    calls.push(call);
    return result;
  };
  const streamers: NonNullable<Parameters<typeof routeCodex>[4]> = {
    full: (_model, _context, options) => record(options?.serviceTier ?? "none"),
    simple: () => record("simple"),
  };
  routeCodex(model("gpt-5.6-sol"), context, undefined, true, streamers);
  routeCodex(model("gpt-5.6-sol"), context, undefined, false, streamers);
  routeCodex(model("gpt-5.5"), context, undefined, true, streamers);
  assert.deepEqual(calls, ["priority", "simple", "simple"]);
});

test("absent or malformed config safely defaults to off", () => {
  const dir = mkdtempSync(join(tmpdir(), "codex-fast-"));
  assert.equal(loadFastMode(dir), false);
  mkdirSync(join(dir, "extensions"));
  writeFileSync(join(dir, "extensions/codex-fast.json"), "{");
  assert.equal(loadFastMode(dir), false);
});
