import type { DiffPage } from "../types";

export function pagesInRange(
  start: number,
  end: number,
  pageSize: number,
): number[] {
  if (end <= start) return [];
  const first = Math.floor(start / pageSize);
  const last = Math.floor((end - 1) / pageSize);
  return Array.from({ length: last - first + 1 }, (_, index) => first + index);
}

// Retain the viewport plus a small LRU margin, independently of total diff length.
export class DiffPages {
  private pages = new Map<number, DiffPage>();
  private required: number[] = [];
  private limit = 3;
  get(page: number) {
    return this.pages.get(page);
  }
  require(pages: number[]) {
    this.required = pages;
    this.limit = Math.max(3, pages.length);
    this.prune();
  }
  put(page: number, value: DiffPage) {
    this.pages.delete(page);
    this.pages.set(page, value);
    this.prune();
  }
  private prune() {
    for (const key of this.pages.keys()) {
      if (this.pages.size <= this.limit) break;
      if (!this.required.includes(key)) this.pages.delete(key);
    }
  }
}
