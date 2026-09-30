import assert from "node:assert/strict";
import { mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { stripVTControlCharacters } from "node:util";
import {
  addSessionToRange,
  BreakdownComponent,
  buildRangeAgg,
  parseSessionFile,
  walkSessionFiles,
} from "../session-breakdown";

for (const width of [40, 200]) {
  test(`palette follows range changes at width ${width}`, () => {
    const ranges = new Map(
      [7, 30, 90, 365].map((days) => {
        const range = buildRangeAgg(days, new Date(2026, 8, 28));
        const model = `test/model-${days}`;
        range.sessions = 1;
        range.modelSessions.set(model, 1);
        range.modelCost.set(model, 1);
        const day = range.days[0];
        day.sessions = 1;
        day.sessionsByModel.set(model, 1);

        return [days, range];
      }),
    );

    const component = new BreakdownComponent({ ranges }, { requestRender() {} }, () => {});

    for (const [key, days] of [
      ["2", 30],
      ["1", 7],
      ["3", 90],
      ["4", 365],
      ["2", 30],
    ] as const) {
      component.handleInput(key);
      const lines = component.render(width);
      const output = stripVTControlCharacters(lines.join("\n"));
      assert.ok(output.includes(`Top models (${days}d palette):`));
      assert.ok(output.includes(`█ model-${days}`));

      for (const otherDays of ranges.keys()) {
        if (otherDays !== days) assert.ok(!output.includes(`█ model-${otherDays}`));
      }

      // Both the active graph cell and its legend swatch use the top-model color.
      assert.equal(lines.join("\n").split("\x1b[38;2;64;196;99m").length - 1, 2);
    }
  });
}

test("an empty selected range renders an empty model palette", () => {
  const empty = buildRangeAgg(7, new Date(2026, 8, 28));

  const component = new BreakdownComponent(
    { ranges: new Map([[7, empty]]) },
    { requestRender() {} },
    () => {},
  );

  component.handleInput("1");
  const output = stripVTControlCharacters(component.render(100).join("\n"));
  assert.ok(output.includes("Top models (7d palette):"));
  assert.ok(output.includes("█ other"));
  assert.ok(output.includes("(no model data found)"));
});

test("subagent details avoid double-counting and incomplete details fall back to aggregate usage", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "session-breakdown-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const file = join(root, "2026-09-28T12-00-00-000Z_test.jsonl");

  const usage = (cost: number, tokens: number) => ({
    input: tokens,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: tokens,
    cost: { input: cost, output: 0, cacheRead: 0, cacheWrite: 0, total: cost },
  });

  const entries = [
    { type: "model_change", provider: "test", modelId: "parent" },
    {
      type: "message",
      message: {
        role: "assistant",
        provider: "test",
        model: "parent",
        usage: usage(1, 10),
      },
    },
    {
      type: "message",
      message: {
        role: "toolResult",
        toolName: "subagent",
        usage: usage(3, 30),
        details: {
          results: [
            {
              model: "test/child",
              messages: [{ role: "user" }, { role: "assistant", usage: usage(3, 30) }],
            },
          ],
        },
      },
    },
    {
      type: "message",
      message: {
        role: "toolResult",
        toolName: "subagent",
        usage: usage(2, 20),
        details: {
          results: [{ model: "test/incomplete", messages: [{ role: "user" }] }],
        },
      },
    },
  ];

  writeFileSync(file, entries.map((entry) => JSON.stringify(entry)).join("\n"));

  const session = await parseSessionFile(file);
  assert.ok(session);
  assert.equal(session.messages, 6);
  assert.equal(session.tokens, 60);
  assert.equal(session.totalCost, 6);
  assert.equal(session.tokensByModel.get("test/parent"), 10);
  assert.equal(session.tokensByModel.get("test/child"), 30);
  assert.equal(session.tokensByModel.get("subagent/unknown"), 20);
  assert.equal(session.costByModel.get("test/parent"), 1);
  assert.equal(session.costByModel.get("test/child"), 3);
  assert.equal(session.costByModel.get("subagent/unknown"), 2);
});

test("cost mode renders daily spend and cost-weighted model colors", () => {
  const range = buildRangeAgg(7, new Date(2026, 8, 28));
  const expensive = "test/expensive";
  const cheap = "test/cheap";
  range.sessions = 2;
  range.totalCost = 16;
  range.modelCost.set(expensive, 8);
  range.modelCost.set(cheap, 8);

  const expensiveDay = range.days[0];
  expensiveDay.sessions = 1;
  expensiveDay.totalCost = 8;
  expensiveDay.costByModel.set(expensive, 8);

  const cheapDay = range.days[1];
  cheapDay.sessions = 1;
  cheapDay.totalCost = 8;
  cheapDay.costByModel.set(cheap, 8);

  const component = new BreakdownComponent(
    { ranges: new Map([[7, range]]) },
    { requestRender() {} },
    () => {},
  );

  selectCost(component);

  const lines = component.render(200);
  const output = stripVTControlCharacters(lines.join("\n"));
  assert.ok(output.includes("[cost]"));
  assert.ok(output.includes("(graph: cost/day)"));
  assert.match(output, /test\/expensive\s+\$8\.00\s+50%/);
  assert.match(output, /test\/cheap\s+\$8\.00\s+50%/);
  assert.equal(lines.join("\n").split("\x1b[38;2;64;196;99m").length - 1, 2);
  assert.equal(lines.join("\n").split("\x1b[38;2;47;129;247m").length - 1, 2);
});

test("cost mode falls back when the selected range has no cost data", () => {
  const range = buildRangeAgg(7, new Date(2026, 8, 28));
  const model = "test/model";
  range.sessions = 1;
  range.totalTokens = 100;
  range.modelTokens.set(model, 100);
  const day = range.days[0];
  day.sessions = 1;
  day.tokens = 100;
  day.tokensByModel.set(model, 100);

  const component = new BreakdownComponent(
    { ranges: new Map([[7, range]]) },
    { requestRender() {} },
    () => {},
  );

  selectCost(component);

  const lines = component.render(100);
  const output = stripVTControlCharacters(lines.join("\n"));
  assert.ok(output.includes("[cost]"));
  assert.ok(output.includes("(graph: tokens/day)"));
  assert.equal(lines.join("\n").split("\x1b[38;2;64;196;99m").length - 1, 2);
});

test("non-message usage and requests land on their own local days, not session start", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "session-breakdown-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const file = join(root, "session.jsonl");
  const before = new Date(2026, 8, 20, 12).toISOString();
  const yesterday = new Date(2026, 8, 27, 23).toISOString();
  const today = new Date(2026, 8, 28, 12).toISOString();

  const entries = [
    { type: "session", timestamp: before },
    { type: "model_change", provider: "test", modelId: "parent" },
    {
      type: "message",
      timestamp: before,
      message: { role: "assistant", usage: { totalTokens: 100, cost: 10 } },
    },
    {
      type: "compaction",
      timestamp: yesterday,
      usage: { input: 1, output: 2, cacheRead: 3, cacheWrite: 4, reasoning: 2, cost: { total: 1 } },
    },
    { type: "branch_summary", timestamp: today, usage: { totalTokens: 20, cost: 2 } },
    {
      type: "usage",
      timestamp: today,
      provider: "test",
      model: "warm",
      usage: { totalTokens: 30, cost: 3 },
    },
    // Inner request timestamp wins over the wrapper's persistence timestamp.
    {
      type: "message",
      timestamp: today,
      message: {
        role: "assistant",
        timestamp: new Date(yesterday).getTime(),
        usage: { totalTokens: 40, cost: 4 },
      },
    },
    {
      type: "message",
      timestamp: today,
      message: {
        role: "toolResult",
        toolName: "subagent",
        usage: { totalTokens: 60, cost: 6 },
        details: {
          results: [
            {
              model: "test/child",
              messages: [
                {
                  role: "assistant",
                  timestamp: new Date(yesterday).getTime(),
                  usage: { totalTokens: 50, cost: 5 },
                },
                // Missing timestamps fall back to the tool result, not session start.
                { role: "user" },
              ],
            },
          ],
        },
      },
    },
  ];

  writeFileSync(file, entries.map((entry) => JSON.stringify(entry)).join("\n"));
  const session = await parseSessionFile(file);
  assert.ok(session);
  assert.equal(session.totalCost, 26);
  assert.equal(session.messages, 5);

  const range = buildRangeAgg(2, new Date(today));
  addSessionToRange(range, session);
  assert.equal(range.sessions, 0);
  assert.equal(range.totalCost, 16);
  assert.equal(range.totalTokens, 160);
  assert.equal(range.totalMessages, 4);
  assert.equal(range.days[0].totalCost, 10);
  assert.equal(range.days[0].tokens, 100);
  assert.equal(range.days[0].messages, 2);
  assert.equal(range.days[1].totalCost, 6);
  assert.equal(range.days[1].messages, 2);
  assert.equal(range.modelCost.get("test/child"), 5);
  assert.equal(range.modelCost.get("test/warm"), 3);
  assert.equal(range.modelCost.get("subagent/unknown"), 1);

  const full = buildRangeAgg(30, new Date(today));
  addSessionToRange(full, session);
  assert.equal(full.sessions, 1);
  assert.equal(full.totalCost, 26);
});

test("per-child aggregates fill only their own gaps and preserve recorded model/date attribution", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "session-breakdown-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const file = join(root, "aggregate.jsonl");
  const yesterday = new Date(2026, 8, 27, 12).toISOString();
  const today = new Date(2026, 8, 28, 12).toISOString();

  const entries = [
    { type: "session", timestamp: yesterday },
    { type: "model_change", provider: "test", modelId: "parent" },
    {
      type: "message",
      timestamp: today,
      message: {
        role: "toolResult",
        toolName: "subagent",
        usage: { totalTokens: 200, cost: 20 },
        details: {
          results: [
            {
              model: "test/one",
              usage: { totalTokens: 50, cost: { total: 5 } },
              messages: [
                { role: "assistant", timestamp: yesterday, usage: { totalTokens: 20, cost: 2 } },
              ],
              usageEntries: [
                {
                  type: "compaction",
                  timestamp: yesterday,
                  provider: "test",
                  model: "summarizer",
                  usage: { totalTokens: 10, cost: 1 },
                },
              ],
            },
            // Older per-child summaries used a scalar cost and lacked full token totals.
            { model: "test/two", usage: { input: 10, output: 10, cost: 4 }, messages: [] },
            // Detailed usage wins over an incomplete/lower aggregate.
            {
              model: "test/three",
              usage: { totalTokens: 10, cost: 1 },
              messages: [{ role: "assistant", usage: { totalTokens: 60, cost: 6 } }],
            },
            { usage: { totalTokens: 20, cost: 2 } },
            null,
          ],
        },
      },
    },
  ];

  writeFileSync(file, entries.map((entry) => JSON.stringify(entry)).join("\n"));
  const session = await parseSessionFile(file);
  assert.ok(session);
  assert.equal(session.totalCost, 20);
  assert.equal(session.tokens, 200);
  assert.equal(session.messages, 3);
  assert.equal(session.costByModel.get("test/one"), 4);
  assert.equal(session.costByModel.get("test/summarizer"), 1);
  assert.equal(session.costByModel.get("test/two"), 4);
  assert.equal(session.costByModel.get("test/three"), 6);
  assert.equal(session.costByModel.get("subagent/unknown"), 5);
  assert.equal(session.tokensByModel.get("test/one"), 40);
  assert.equal(session.tokensByModel.get("test/two"), 20);
  assert.equal(session.tokensByModel.get("subagent/unknown"), 70);
  const range = buildRangeAgg(1, new Date(today));
  addSessionToRange(range, session);
  assert.equal(range.totalTokens, 170);
  assert.equal(range.totalCost, 17);
});

test("aggregate-only subagent results never inherit the parent's model", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "session-breakdown-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const timestamp = new Date(2026, 8, 28, 12).toISOString();

  for (const details of [
    undefined,
    { results: [] },
    { results: [{ model: "test/alone", usage: { totalTokens: 30, cost: 3 } }] },
  ]) {
    const file = join(root, "aggregate-only.jsonl");
    writeFileSync(
      file,
      [
        { type: "session", timestamp },
        { type: "model_change", provider: "test", modelId: "parent" },
        {
          type: "message",
          timestamp,
          message: {
            role: "toolResult",
            toolName: "subagent",
            usage: { totalTokens: 30, cost: 3 },
            details,
          },
        },
      ]
        .map((entry) => JSON.stringify(entry))
        .join("\n"),
    );
    const session = await parseSessionFile(file);
    assert.ok(session);
    assert.equal(session.totalCost, 3);
    assert.equal(session.tokens, 30);
    assert.equal(session.messages, 1);
    assert.equal(session.costByModel.has("test/parent"), false);
    const model = details?.results[0]?.model ?? "subagent/unknown";
    assert.equal(session.costByModel.get(model), 3);
  }
});

test("recently modified old sessions are scanned", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "session-breakdown-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const file = join(root, "2020-01-01T12-00-00-000Z_test.jsonl");
  writeFileSync(file, "");
  const recent = new Date(2026, 8, 28, 12);
  utimesSync(file, recent, recent);
  assert.deepEqual(await walkSessionFiles(root, new Date(2026, 8, 22)), [file]);
  utimesSync(file, new Date(2020, 0, 1), new Date(2020, 0, 1));
  assert.deepEqual(await walkSessionFiles(root, new Date(2026, 8, 22)), []);
});

test("copied entries are deduplicated by identity, not equal usage", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "session-breakdown-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));

  const entries = [
    { type: "session", timestamp: "2026-09-28T12:00:00Z" },
    { type: "model_change", provider: "test", modelId: "parent" },
    {
      type: "message",
      id: "request",
      timestamp: "2026-09-28T12:01:00Z",
      message: { role: "assistant", usage: { totalTokens: 10, cost: 1 } },
    },
    {
      type: "compaction",
      id: "compact",
      timestamp: "2026-09-28T12:02:00Z",
      usage: { totalTokens: 20, cost: 2 },
    },
  ];

  const first = join(root, "first.jsonl");
  const fork = join(root, "fork.jsonl");
  writeFileSync(first, entries.map((entry) => JSON.stringify(entry)).join("\n"));
  writeFileSync(
    fork,
    [...entries, { ...entries[2], id: "new-request" }]
      .map((entry) => JSON.stringify(entry))
      .join("\n"),
  );
  const seen = new Set<string>();
  const original = await parseSessionFile(first, undefined, seen);
  const copied = await parseSessionFile(fork, undefined, seen);
  assert.ok(original);
  assert.ok(copied);
  assert.equal(original.totalCost, 3);
  assert.equal(copied.totalCost, 1);
  assert.equal(copied.messages, 1);
  assert.equal(copied.tokens, 10);
});

function selectCost(component: BreakdownComponent): void {
  component.handleInput("1");
  component.handleInput("t");
  component.handleInput("t");
  component.handleInput("t");
}
