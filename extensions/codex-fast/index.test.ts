import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createAssistantMessageEventStream, type Model } from "@earendil-works/pi-ai";
import { isCodex, loadFastMode, routeCodex } from "./index";

const model = (id: string) =>
  ({
    id,
    provider: "openai-codex",
    api: "openai-codex-responses",
  }) as Model<"openai-codex-responses">;
const context = { messages: [] };

test("Codex detection is provider-scoped, not model-name-scoped", () => {
  for (const id of ["gpt-6-astra", "gpt-5.6-sol", "future-model"]) {
    assert.ok(isCodex(model(id)));
    assert.equal(isCodex({ ...model(id), provider: "openai" }), false);
  }
  assert.equal(isCodex(undefined), false);
});

test("priority routing applies to any Codex model only when enabled", () => {
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
  for (const id of [
    "gpt-6-astra",
    "gpt-5.6-sol",
    "gpt-5.6-terra",
    "gpt-5.6-luna",
    "future-model",
  ]) {
    assert.equal(routeCodex(model(id), context, undefined, true, streamers), result);
    assert.equal(routeCodex(model(id), context, undefined, false, streamers), result);
    assert.equal(
      routeCodex({ ...model(id), provider: "openai" }, context, undefined, true, streamers),
      result,
    );
    assert.deepEqual(calls.splice(0), ["priority", "simple", "simple"]);
  }
});

test("priority routing preserves reasoning and request options", () => {
  const astra = { ...model("gpt-6-astra"), reasoning: true };
  const options = {
    reasoning: "high" as const,
    signal: new AbortController().signal,
    sessionId: "test",
  };
  const result = createAssistantMessageEventStream();
  const streamers: NonNullable<Parameters<typeof routeCodex>[4]> = {
    full: (model, ctx, actual) => {
      assert.equal(model, astra);
      assert.equal(ctx, context);
      assert.deepEqual(actual, { ...options, reasoningEffort: "high", serviceTier: "priority" });
      return result;
    },
    simple: (_model, _ctx, actual) => {
      assert.equal(actual, options);
      return result;
    },
  };
  routeCodex(astra, context, options, true, streamers);
  routeCodex(astra, context, options, false, streamers);
});

test("absent or malformed config safely defaults to off", () => {
  const dir = mkdtempSync(join(tmpdir(), "codex-fast-"));
  assert.equal(loadFastMode(dir), false);
  mkdirSync(join(dir, "extensions"));
  writeFileSync(join(dir, "extensions/codex-fast.json"), "{");
  assert.equal(loadFastMode(dir), false);
});
