import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import { loadConfig, type SubagentModels, saveConfig } from "./config";

let root: string;
let path: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "subagent-models-config-"));
  path = join(root, "extensions", "subagent-models.json");
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

const config: SubagentModels = {
  eye: ["openrouter/anthropic/frontier", "codex/primary"],
  hand: "codex/small",
  reasoning: {
    eye: { "openrouter/anthropic/frontier": "high", "codex/primary": "off" },
    hand: "low",
  },
};

test("missing config is empty; exact IDs, order and role-specific reasoning round-trip", () => {
  const initial = loadConfig(path);
  assert.deepEqual(initial, {
    config: { eye: [], hand: null, reasoning: { eye: {}, hand: null } },
    raw: null,
  });
  saveConfig(path, initial.raw, config);
  const saved = loadConfig(path);
  assert.deepEqual(saved.config, config);
  saveConfig(path, saved.raw, { eye: [], hand: null, reasoning: { eye: {}, hand: null } });
  assert.deepEqual(loadConfig(path).config, {
    eye: [],
    hand: null,
    reasoning: { eye: {}, hand: null },
  });
  assert.deepEqual(readdirSync(join(root, "extensions")), ["subagent-models.json"]);
});

test("model IDs with internal spaces round-trip without locking the picker out", () => {
  const config: SubagentModels = {
    eye: ["local/my model"],
    hand: "local/my model",
    reasoning: { eye: { "local/my model": "high" }, hand: "off" },
  };
  saveConfig(path, null, config);
  assert.deepEqual(loadConfig(path).config, config);
});

test("invalid or unreadable configuration is not silently reset", () => {
  mkdirSync(join(root, "extensions"));
  for (const raw of [
    "{",
    "null",
    "[]",
    "{}",
    '{"eye":["a/b"],"hand":null}',
    '{"eye":[],"hand":["a/b"]}',
    '{"eye":["a/b","a/b"],"hand":null}',
    '{"eye":["no-provider"],"hand":null}',
    '{"eye":[],"hand":"a/"}',
    '{"eye":[],"hand":"a/b ","extra":true}',
    '{"eye":[],"hand":null,"reasoning":null}',
    '{"eye":[],"hand":null,"reasoning":{"eye":{"a/b":"high"},"hand":null}}',
    '{"eye":["a/b"],"hand":null,"reasoning":{"eye":{},"hand":null}}',
    '{"eye":[],"hand":"a/b","reasoning":{"eye":{},"hand":null}}',
    '{"eye":[],"hand":null,"reasoning":{"eye":{},"hand":"high"}}',
    '{"eye":["a/b"],"hand":null,"reasoning":{"eye":{"a/b":"ultra"},"hand":null}}',
  ]) {
    writeFileSync(path, raw);
    assert.throws(() => loadConfig(path));
    assert.equal(readFileSync(path, "utf8"), raw);
  }
  rmSync(path);
  mkdirSync(path);
  assert.throws(() => loadConfig(path));
});

test("stale sessions cannot overwrite another writer's creation, edit or deletion", () => {
  saveConfig(path, null, config);
  assert.throws(() => saveConfig(path, null, { ...config, eye: [] }), /changed/);
  const baseline = loadConfig(path).raw;
  saveConfig(path, baseline, {
    ...config,
    hand: null,
    reasoning: { ...config.reasoning, hand: null },
  });
  assert.throws(() => saveConfig(path, baseline, config), /changed/);
  assert.equal(loadConfig(path).config.hand, null);
  rmSync(path);
  assert.throws(() => saveConfig(path, baseline, config), /changed/);
  assert.deepEqual(readdirSync(join(root, "extensions")), []);
});

test("a competing lock is respected and never removed by the losing writer", () => {
  mkdirSync(join(root, "extensions"));
  writeFileSync(`${path}.lock`, "other writer");
  assert.throws(() => saveConfig(path, null, config), /Config is locked/);
  assert.equal(readFileSync(`${path}.lock`, "utf8"), "other writer");
  assert.equal(loadConfig(path).raw, null);
});

test("failed saves release their lock and leave the existing path untouched", () => {
  mkdirSync(path, { recursive: true });
  assert.throws(() => saveConfig(path, null, config));
  assert.deepEqual(readdirSync(join(root, "extensions")), ["subagent-models.json"]);
});
