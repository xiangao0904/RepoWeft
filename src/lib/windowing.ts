export function windowRange(
  count: number,
  top: number,
  height: number,
  rowHeight: number,
) {
  const start = Math.min(
    Math.max(0, Math.floor(top / rowHeight) - 6),
    Math.max(0, count - 1),
  );
  return {
    start,
    end: Math.min(count, start + Math.ceil(height / rowHeight) + 12),
  };
}
export const HISTORY_LIMIT = 1000;
export function appendHistory<T>(previous: T[], next: T[], offset: number) {
  const all = [...previous, ...next];
  const removed = Math.max(0, all.length - HISTORY_LIMIT);
  return { items: all.slice(removed), offset: offset + removed, removed };
}
