export function createWriteQueue(
  write: (key: string, value: unknown) => void,
  delay = 300,
) {
  const pending = new Map<string, unknown>();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const flush = () => {
    clearTimeout(timer);
    timer = undefined;
    for (const [key, value] of pending) {
      try {
        write(key, value);
      } catch {
        /* Storage is optional. */
      }
    }
    pending.clear();
  };
  return {
    set(key: string, value: unknown) {
      pending.set(key, value);
      clearTimeout(timer);
      timer = setTimeout(flush, delay);
    },
    flush,
  };
}
