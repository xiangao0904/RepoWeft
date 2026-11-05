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
    points.push({ lane, color });
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
  }
  return { points, edges, width: Math.max(66, 45 + maxLane * 20) };
}
