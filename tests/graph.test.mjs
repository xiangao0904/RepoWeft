import test from "node:test";
import assert from "node:assert/strict";
import { layoutGraph } from "../src/lib/graph.ts";

function commit(hash, parents = []) {
  return {
    hash,
    parents,
    author: "Test",
    email: "test@example.com",
    timestamp: 0,
    message: hash,
    refs: [],
  };
}
test("linear history shares one lane", () => {
  const graph = layoutGraph([
    commit("a", ["b"]),
    commit("b", ["c"]),
    commit("c"),
  ]);
  assert.deepEqual(
    graph.points.map((p) => p.lane),
    [0, 0, 0],
  );
  assert.equal(graph.edges.length, 2);
});
test("merge edges land on their parent nodes across branches", () => {
  const graph = layoutGraph([
    commit("merge", ["left", "right"]),
    commit("left", ["root"]),
    commit("right", ["root"]),
    commit("root"),
  ]);
  assert.notEqual(graph.points[1].lane, graph.points[2].lane);
  for (const edge of graph.edges) {
    assert.equal(edge.toLane, graph.points[edge.to].lane);
    assert.equal(edge.fromLane, graph.points[edge.from].lane);
    assert.ok(edge.to > edge.from);
  }
});
test("parents outside the loaded page continue beyond its boundary", () => {
  const graph = layoutGraph([commit("a", ["unloaded"])]);
  assert.equal(graph.edges[0].to, 1);
});
test("octopus merges allocate enough horizontal room", () => {
  const parents = Array.from({ length: 8 }, (_, i) => `p${i}`);
  const graph = layoutGraph([
    commit("merge", parents),
    ...parents.map((p) => commit(p)),
  ]);
  assert.equal(new Set(graph.points.slice(1).map((p) => p.lane)).size, 8);
  assert.ok(graph.width > 25 + 7 * 20);
});
