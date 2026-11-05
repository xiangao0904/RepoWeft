import test from "node:test";
import assert from "node:assert/strict";
import { ReadRequests } from "../src/lib/requests.ts";
test("shared read survives one consumer leaving, then aborts when the last leaves", async () => {
  const requests = new ReadRequests();
  const a = new AbortController(),
    b = new AbortController();
  let calls = 0,
    active;
  const work = (signal) => {
    calls++;
    active = signal;
    return new Promise(() => {});
  };
  const first = requests.run("repo", "log", work, a.signal);
  const second = requests.run("repo", "log", work, b.signal);
  await Promise.resolve();
  a.abort();
  await assert.rejects(first, { name: "AbortError" });
  assert.equal(calls, 1);
  assert.equal(active.aborted, false);
  b.abort();
  await assert.rejects(second, { name: "AbortError" });
  assert.equal(active.aborted, true);
});
test("closing a repository cancels only its reads and allows a fresh reopen", async () => {
  const requests = new ReadRequests();
  const old = requests.run("a", "diff", () => new Promise(() => {}));
  const other = requests.run("b", "log", async () => 42);
  requests.cancel("a");
  await assert.rejects(old, { name: "AbortError" });
  assert.equal(await other, 42);
  assert.equal(await requests.run("a", "diff", async () => 7), 7);
});
