import test from "node:test";
import assert from "node:assert/strict";
import { createPageGate } from "../src/lib/paging.ts";
test("repeated bottom intersections request one page at a time and permit the next page", () => {
  const gate = createPageGate();
  const first = gate.begin();
  assert.notEqual(first, null);
  assert.equal(gate.begin(), null);
  assert.equal(gate.finish(first), true);
  assert.notEqual(gate.begin(), null);
});
test("late pages cannot update or unlock history after branch/filter changes", () => {
  const gate = createPageGate();
  const old = gate.begin();
  gate.invalidate();
  const next = gate.begin();
  assert.equal(gate.isCurrent(old), false);
  assert.equal(gate.finish(old), false);
  assert.equal(gate.begin(), null);
  assert.equal(gate.isCurrent(next), true);
  assert.equal(gate.finish(next), true);
});
