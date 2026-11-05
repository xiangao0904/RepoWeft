import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { windowRange } from "../lib/windowing";

// Large auxiliary lists get their own bounded viewport. Small lists retain natural sizing.
export function VirtualList<T>({
  items,
  rowHeight,
  className = "",
  maxHeight = "min(480px, 50vh)",
  render,
}: {
  items: readonly T[];
  rowHeight: number;
  className?: string;
  maxHeight?: string;
  render: (item: T, index: number) => ReactNode;
}) {
  const root = useRef<HTMLDivElement>(null);
  const [viewport, setViewport] = useState({ top: 0, height: 480 });
  const virtual = items.length > 80;
  useEffect(() => {
    const element = root.current;
    if (!element) return;
    const observer = new ResizeObserver(() =>
      setViewport((v) => ({ ...v, height: element.clientHeight })),
    );
    observer.observe(element);
    return () => observer.disconnect();
  }, [virtual]);
  if (!virtual) return <div className={className}>{items.map(render)}</div>;
  const { start, end } = windowRange(
    items.length,
    viewport.top,
    viewport.height,
    rowHeight,
  );
  return (
    <div
      ref={root}
      className="virtual-list-scroll"
      style={{
        maxHeight,
        overflow: "auto",
        overflowAnchor: "none",
      }}
      onScroll={(event) => {
        const top = event.currentTarget.scrollTop;
        setViewport((v) => ({ ...v, top }));
      }}
    >
      <div
        className={`${className} virtual-list-items`}
        style={
          {
            paddingTop: start * rowHeight,
            paddingBottom: (items.length - end) * rowHeight,
            gap: 0,
            "--virtual-row-height": `${rowHeight}px`,
          } as React.CSSProperties
        }
      >
        {items
          .slice(start, end)
          .map((item, index) => render(item, start + index))}
      </div>
    </div>
  );
}

export function VirtualDiff({
  text,
  compact,
}: {
  text: string;
  compact: boolean;
}) {
  const root = useRef<HTMLDivElement>(null);
  const [viewport, setViewport] = useState({ top: 0, height: 800 });
  // Store offsets instead of one additional string per line for large patches.
  const source = useMemo(() => {
    let count = 1;
    for (let i = 0; i < text.length; i++)
      if (text.charCodeAt(i) === 10) count++;
    const offsets = new Uint32Array(count);
    let line = 1;
    for (let i = 0; i < text.length; i++)
      if (text.charCodeAt(i) === 10) offsets[line++] = i + 1;
    return offsets;
  }, [text]);
  const width = useRef(0);
  useEffect(() => {
    width.current = 0;
    if (root.current) root.current.scrollTop = 0;
    setViewport((v) => ({ ...v, top: 0 }));
  }, [text]);
  useEffect(() => {
    const pre = root.current?.firstElementChild as HTMLElement | null;
    if (pre) {
      width.current = Math.max(width.current, pre.scrollWidth);
      pre.style.minWidth = `${width.current}px`;
    }
  });
  const rowHeight = compact ? 20 : 24;
  useEffect(() => {
    const element = root.current!;
    const observer = new ResizeObserver(() =>
      setViewport((v) => ({ ...v, height: element.clientHeight })),
    );
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  const { start, end } = windowRange(
    source.length,
    viewport.top,
    viewport.height,
    rowHeight,
  );
  return (
    <div
      ref={root}
      className={`diff-view ${compact ? "compact" : ""}`}
      onScroll={(event) => {
        const top =
          Math.floor(event.currentTarget.scrollTop / rowHeight) * rowHeight;
        setViewport((v) => (v.top === top ? v : { ...v, top }));
      }}
    >
      <pre
        style={{
          paddingTop: 10 + start * rowHeight,
          paddingBottom: 10 + (source.length - end) * rowHeight,
        }}
      >
        {Array.from(source.subarray(start, end), (offset, index) => {
          const i = start + index;
          const line = text.slice(
            offset,
            i + 1 < source.length ? source[i + 1] - 1 : text.length,
          );
          return (
            <div
              key={i}
              style={{ height: rowHeight }}
              className={
                line.startsWith("+")
                  ? "diff-add"
                  : line.startsWith("-")
                    ? "diff-remove"
                    : line.startsWith("@@")
                      ? "diff-hunk"
                      : ""
              }
            >
              <span className="line-number">{i + 1}</span>
              <span>{line || " "}</span>
            </div>
          );
        })}
      </pre>
    </div>
  );
}
