import test from "node:test";
import assert from "node:assert/strict";
import { DiffPages, pagesInRange } from "../src/lib/diffPages.ts";
const page = (index) => ({
  start: index * 128,
  lines: [{ text: `page-${index}`, kind: "context" }],
});
test("visible ranges fetch only the pages they overlap", () => {
  assert.deepEqual(pagesInRange(0, 0, 128), []);
  assert.deepEqual(pagesInRange(0, 128, 128), [0]);
  assert.deepEqual(pagesInRange(120, 170, 128), [0, 1]);
  assert.deepEqual(pagesInRange(99960, 100000, 128), [780, 781]);
});
test("long browsing retains a bounded margin without evicting visible pages", () => {
  const cache = new DiffPages();
  for (let i = 0; i < 1000; i++) {
    cache.require([i]);
    cache.put(i, page(i));
    assert.ok(cache.get(i));
    if (i > 2) assert.equal(cache.get(i - 3), undefined);
  }
  cache.require([0, 1]);
  cache.put(0, page(0));
  cache.put(1, page(1));
  assert.ok(cache.get(0));
  assert.ok(cache.get(1));
  assert.equal(cache.get(998), undefined);
});
test("unusually tall viewports keep every required page", () => {
  const cache = new DiffPages();
  cache.require([0, 1, 2, 3, 4]);
  for (let i = 0; i < 5; i++) cache.put(i, page(i));
  for (let i = 0; i < 5; i++) assert.ok(cache.get(i));
  cache.require([9]);
  cache.put(9, page(9));
  assert.equal(cache.get(0), undefined);
  assert.equal(cache.get(1), undefined);
  assert.ok(cache.get(9));
});
