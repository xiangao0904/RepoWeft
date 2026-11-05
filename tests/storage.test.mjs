import test from "node:test";
import assert from "node:assert/strict";
import { createWriteQueue } from "../src/lib/storageQueue.ts";
test("drag updates coalesce and final values flush together", () => {
  const writes = [];
  const queue = createWriteQueue((key, value) => writes.push([key, value]));
  for (let i = 0; i < 100; i++) queue.set("width", i);
  queue.set("repos", ["a"]);
  assert.equal(writes.length, 0);
  queue.flush();
  queue.flush();
  assert.deepEqual(writes, [
    ["width", 99],
    ["repos", ["a"]],
  ]);
});
