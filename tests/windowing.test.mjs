import test from "node:test";
import assert from "node:assert/strict";
import {
  windowRange,
  appendHistory,
  HISTORY_LIMIT,
} from "../src/lib/windowing.ts";
test("a million lines still mounts only a viewport and overscan", () => {
  const range = windowRange(1_000_000, 240000, 720, 24);
  assert.equal(range.end - range.start, 42);
  assert.ok(range.start <= 10000 && range.end > 10000);
  assert.deepEqual(windowRange(0, 1000, 720, 24), { start: 0, end: 0 });
});
test("history window preserves absolute pagination offsets while bounding memory", () => {
  const prior = Array.from({ length: HISTORY_LIMIT }, (_, i) => i);
  const result = appendHistory(prior, [1000, 1001], 200);
  assert.equal(result.items.length, HISTORY_LIMIT);
  assert.equal(result.offset, 202);
  assert.equal(result.items[0], 2);
  assert.equal(result.offset + result.items.length, 1202);
});
