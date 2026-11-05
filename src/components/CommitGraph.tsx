import type { layoutGraph } from "../lib/graph";

export function CommitGraph({
  graph,
  start,
  end,
  rowHeight,
  currentIndex = -1,
}: {
  graph: ReturnType<typeof layoutGraph>;
  start: number;
  end: number;
  rowHeight: number;
  currentIndex?: number;
}) {
  return (
    <svg
      className="commit-graph"
      width={graph.width}
      height={graph.points.length * rowHeight}
      aria-hidden="true"
    >
      {graph.visibleEdges(start, end).map((edge, i) => {
        const x1 = 25 + edge.fromLane * 20,
          x2 = 25 + edge.toLane * 20;
        const y1 = edge.from * rowHeight + rowHeight / 2,
          y2 = edge.to * rowHeight + rowHeight / 2;
        return (
          <path
            key={i}
            d={
              x1 === x2
                ? `M ${x1} ${y1} V ${y2}`
                : `M ${x1} ${y1} C ${x1} ${y1 + rowHeight / 4}, ${x2} ${y1 + rowHeight / 4}, ${x2} ${y1 + rowHeight / 2} V ${y2}`
            }
            fill="none"
            stroke={edge.color}
            strokeWidth="2"
            opacity=".85"
          />
        );
      })}
      {graph.points.slice(start, end).map((point, index) => {
        const i = start + index;
        return (
          <g key={i}>
            <circle
              cx={25 + point.lane * 20}
              cy={i * rowHeight + rowHeight / 2}
              r={i === currentIndex ? 7 : 5}
              fill={point.color}
              opacity={i === currentIndex ? ".18" : "1"}
            />
            {i === currentIndex && (
              <circle
                cx={25 + point.lane * 20}
                cy={i * rowHeight + rowHeight / 2}
                r="4"
                fill={point.color}
              />
            )}
          </g>
        );
      })}
    </svg>
  );
}
