import type { Commit } from "../types";

export const graphColors = [
  "#4fb9df",
  "#5dc8b6",
  "#e5b969",
  "#d486b9",
  "#77a5ed",
];
export const graphRowHeight = 70;

// Track pending parents in stable lanes. Missing parents continue to the next page.
export function layoutGraph(commits: Commit[]) {
  const lanes: (string | null)[] = [];
  const points: { lane: number; color: string }[] = [];
  const edges: {
    from: number;
    to: number;
    fromLane: number;
    toLane: number;
    color: string;
  }[] = [];
  const rows = new Map(commits.map((c, i) => [c.hash, i]));
  let maxLane = 0;
  for (let i = 0; i < commits.length; i++) {
    const commit = commits[i];
    let lane = lanes.indexOf(commit.hash);
    if (lane < 0) {
      lane = lanes.indexOf(null);
      if (lane < 0) lane = lanes.length;
    }
    lanes[lane] = null;
    const color = graphColors[lane % graphColors.length];
    maxLane = Math.max(maxLane, lane);
    commit.parents.forEach((parent, j) => {
      let targetLane = lanes.indexOf(parent);
      if (targetLane < 0) {
        targetLane =
          j === 0 && lanes[lane] === null ? lane : lanes.indexOf(null);
        if (targetLane < 0) targetLane = lanes.length;
        lanes[targetLane] = parent;
      }
      maxLane = Math.max(maxLane, targetLane);
      edges.push({
        from: i,
        to: rows.get(parent) ?? commits.length,
        fromLane: lane,
        toLane: targetLane,
        color: graphColors[targetLane % graphColors.length],
      });
    });
    points.push({ lane, color });
  }
  return {
    points,
    edges,
    visibleEdges: indexEdges(edges),
    width: Math.max(66, 45 + maxLane * 20),
  };
}

// Edges are ordered by their start row. Max end rows let us skip entire offscreen ranges.
export function indexEdges<T extends { from: number; to: number }>(edges: T[]) {
  const maxEnd = new Int32Array(Math.max(1, edges.length * 4));
  function build(node: number, left: number, right: number): number {
    if (left === right) return (maxEnd[node] = edges[left].to);
    const middle = (left + right) >>> 1;
    return (maxEnd[node] = Math.max(
      build(node * 2, left, middle),
      build(node * 2 + 1, middle + 1, right),
    ));
  }
  if (edges.length) build(1, 0, edges.length - 1);
  return (start: number, end: number) => {
    const result: T[] = [];
    function visit(node: number, left: number, right: number) {
      if (maxEnd[node] < start || edges[left].from > end) return;
      if (left === right) {
        result.push(edges[left]);
        return;
      }
      const middle = (left + right) >>> 1;
      visit(node * 2, left, middle);
      visit(node * 2 + 1, middle + 1, right);
    }
    if (edges.length) visit(1, 0, edges.length - 1);
    return result;
  };
}
