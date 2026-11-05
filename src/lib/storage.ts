import { useEffect, useState } from "react";

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
    try {
      localStorage.setItem(`repoweft.v1.${key}`, JSON.stringify(value));
    } catch {
      /* In-memory state remains available. */
    }
  }, [key, value]);
  return [value, setValue] as const;
}
