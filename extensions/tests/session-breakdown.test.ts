import assert from "node:assert/strict";
import { test } from "node:test";
import { stripVTControlCharacters } from "node:util";
import type { TUI } from "@earendil-works/pi-tui";
import { BreakdownComponent, buildRangeAgg } from "../session-breakdown";

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
    const component = new BreakdownComponent({ ranges }, { requestRender() {} } as TUI, () => {});

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
    { requestRender() {} } as TUI,
    () => {},
  );
  component.handleInput("1");
  const output = stripVTControlCharacters(component.render(100).join("\n"));
  assert.ok(output.includes("Top models (7d palette):"));
  assert.ok(output.includes("█ other"));
  assert.ok(output.includes("(no model data found)"));
});
