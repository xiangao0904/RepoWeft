import test from "node:test";
import assert from "node:assert/strict";
import { BudgetCache } from "../src/lib/cache.ts";
test("cache enforces bytes, LRU access and expiry", () => {
  let now = 0;
  const cache = new BudgetCache(48, 100, () => now);
  cache.set("a", "aaaa");
  cache.set("b", "bbbb");
  assert.equal(cache.get("a"), "aaaa");
  cache.set("c", "cccc");
  assert.equal(cache.get("b"), undefined);
  cache.set("large", "x".repeat(50));
  assert.equal(cache.get("large"), undefined);
  now = 101;
  assert.equal(cache.get("a"), undefined);
  assert.equal(cache.get("c"), undefined);
});
test("release removes one repository without evicting another", () => {
  const cache = new BudgetCache(1024, 1000);
  cache.set("repo:a", 1);
  cache.set("repo:b", 2);
  cache.set("other:a", 3);
  cache.deletePrefix("repo:");
  assert.equal(cache.get("repo:a"), undefined);
  assert.equal(cache.get("other:a"), 3);
});

test("entry count is bounded even for tiny values", () => {
  const cache = new BudgetCache(10000, 1000, Date.now, 2);
  cache.set("a", 1);
  cache.set("b", 2);
  cache.set("c", 3);
  assert.equal(cache.get("a"), undefined);
  assert.equal(cache.get("c"), 3);
});
