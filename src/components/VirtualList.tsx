import { useI18n, errorText } from "../lib/i18n";
import { isReadCancelled } from "../lib/requests";
import { DiffPages, pagesInRange } from "../lib/diffPages";
import type { DiffSource } from "../types";
import { useEffect, useRef, useState, type ReactNode } from "react";
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
  source,
  compact,
}: {
  source: DiffSource;
  compact: boolean;
}) {
  const { t } = useI18n();
  const root = useRef<HTMLDivElement>(null);
  const pre = useRef<HTMLPreElement>(null);
  const [viewport, setViewport] = useState({ top: 0, height: 800 });
  const [pages] = useState(() => new DiffPages());
  const [, updatePages] = useState(0);
  const [retry, setRetry] = useState(0);
  const [error, setError] = useState("");
  const width = useRef(0);
  const rowHeight = compact ? 20 : 24;
  const { start, end } = windowRange(
    source.totalLines,
    viewport.top,
    viewport.height,
    rowHeight,
  );
  const required = pagesInRange(start, end, source.pageSize);
  const pageKey = required.join(",");
  useEffect(() => {
    const controller = new AbortController();
    pages.require(required);
    setError("");
    for (const page of required) {
      if (pages.get(page)) continue;
      void source
        .readPage(page, controller.signal)
        .then((value) => {
          if (controller.signal.aborted) return;
          pages.put(page, value);
          updatePages((version) => version + 1);
        })
        .catch((error) => {
          if (!controller.signal.aborted && !isReadCancelled(error))
            setError(errorText(error, t));
        });
    }
    return () => controller.abort();
  }, [source, pageKey, retry, t]);
  useEffect(() => {
    const element = root.current!;
    const observer = new ResizeObserver(() =>
      setViewport((v) => ({ ...v, height: element.clientHeight })),
    );
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  useEffect(() => {
    if (!pre.current) return;
    width.current = Math.max(width.current, pre.current.scrollWidth);
    pre.current.style.minWidth = `${width.current}px`;
  });
  const loading = required.some((page) => !pages.get(page));
  return (
    <div
      ref={root}
      className={`diff-view ${compact ? "compact" : ""}`}
      aria-busy={loading}
      onScroll={(event) => {
        const top =
          Math.floor(event.currentTarget.scrollTop / rowHeight) * rowHeight;
        setViewport((v) => (v.top === top ? v : { ...v, top }));
      }}
    >
      {error && (
        <div className="diff-page-error" role="alert">
          <span>{error}</span>
          <button
            className="text-button"
            onClick={() => setRetry((value) => value + 1)}
          >
            {t("retry")}
          </button>
        </div>
      )}
      <pre
        ref={pre}
        style={{
          paddingTop: 10 + start * rowHeight,
          paddingBottom: 10 + (source.totalLines - end) * rowHeight,
        }}
      >
        {Array.from({ length: end - start }, (_, index) => {
          const i = start + index;
          const page = pages.get(Math.floor(i / source.pageSize));
          const line = page?.lines[i - page.start];
          return (
            <div
              key={i}
              style={{ height: rowHeight }}
              className={
                line && line.kind !== "context" ? `diff-${line.kind}` : ""
              }
            >
              <span className="line-number">{i + 1}</span>
              <span>
                {line ? (
                  line.text || " "
                ) : (
                  <span className="subtle" aria-label={t("working")}>
                    …
                  </span>
                )}
              </span>
            </div>
          );
        })}
      </pre>
    </div>
  );
}
