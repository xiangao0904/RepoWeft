import { useEffect, useState } from "react";

import { createWriteQueue } from "./storageQueue";
const writes = createWriteQueue((key, value) =>
  localStorage.setItem(`repoweft.v1.${key}`, JSON.stringify(value)),
);
window.addEventListener("pagehide", writes.flush);
window.addEventListener("pointerup", writes.flush);
window.addEventListener("pointercancel", writes.flush);
document.addEventListener("visibilitychange", () => {
  if (document.hidden) writes.flush();
});

export function useStored<T>(key: string, fallback: T) {
  const [value, setValue] = useState<T>(() => {
    try {
      const saved = localStorage.getItem(`repoweft.v1.${key}`);
      return saved ? (JSON.parse(saved) as T) : fallback;
    } catch {
      return fallback;
    }
  });
  useEffect(() => {
    writes.set(key, value);
  }, [key, value]);
  return [value, setValue] as const;
}
