// Estimate retained data without allocating a second JSON representation on the UI thread.
function retainedBytes(value: unknown, seen = new WeakSet<object>()): number {
  if (typeof value === "string") return 16 + value.length * 2;
  if (value === null || typeof value !== "object") return 8;
  if (seen.has(value)) return 0;
  seen.add(value);
  let size = 32;
  if (Array.isArray(value)) {
    for (const item of value) size += 8 + retainedBytes(item, seen);
  } else {
    for (const key of Object.keys(value))
      size +=
        16 +
        key.length * 2 +
        retainedBytes((value as Record<string, unknown>)[key], seen);
  }
  return size;
}
// Bound retained data by both size and age. Reads refresh LRU order, not expiry.
export class BudgetCache<T> {
  private entries = new Map<
    string,
    { value: T; size: number; expires: number }
  >();
  private bytes = 0;
  private budget: number;
  private ttl: number;
  private now: () => number;
  private maxEntries: number;
  constructor(budget: number, ttl: number, now = Date.now, maxEntries = 64) {
    if (budget <= 0 || ttl <= 0 || maxEntries < 1)
      throw new RangeError("Cache limits must be positive");
    this.budget = budget;
    this.ttl = ttl;
    this.now = now;
    this.maxEntries = maxEntries;
  }
  get(key: string): T | undefined {
    const entry = this.entries.get(key);
    if (!entry) return;
    if (entry.expires <= this.now()) {
      this.delete(key);
      return;
    }
    this.entries.delete(key);
    this.entries.set(key, entry);
    return entry.value;
  }
  set(key: string, value: T) {
    this.prune();
    this.delete(key);
    const size = retainedBytes(value);
    if (size > this.budget) return;
    while (
      this.entries.size >= this.maxEntries ||
      this.bytes + size > this.budget
    )
      this.delete(this.entries.keys().next().value!);
    this.entries.set(key, { value, size, expires: this.now() + this.ttl });
    this.bytes += size;
  }
  delete(key: string) {
    const entry = this.entries.get(key);
    if (entry) this.bytes -= entry.size;
    this.entries.delete(key);
  }
  deletePrefix(prefix: string) {
    for (const key of this.entries.keys())
      if (key.startsWith(prefix)) this.delete(key);
  }
  prune() {
    for (const [key, entry] of this.entries)
      if (entry.expires <= this.now()) this.delete(key);
  }
}
