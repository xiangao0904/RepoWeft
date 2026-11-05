// Share transport work while allowing each view to independently release its interest.
export class ReadRequests {
  private jobs = new Map<
    string,
    {
      scope: string;
      controller: AbortController;
      promise: Promise<unknown>;
      users: number;
    }
  >();
  run<T>(
    scope: string,
    key: string,
    work: (signal: AbortSignal) => Promise<T>,
    signal?: AbortSignal,
  ): Promise<T> {
    if (signal?.aborted)
      return Promise.reject(new DOMException("Cancelled", "AbortError"));
    const id = `${scope}:${key}`;
    let job = this.jobs.get(id);
    if (!job) {
      const controller = new AbortController();
      job = {
        scope,
        controller,
        promise: Promise.resolve().then(() => {
          controller.signal.throwIfAborted();
          return work(controller.signal);
        }),
        users: 0,
      };
      this.jobs.set(id, job);
    }
    const task = job;
    task.users++;
    return new Promise<T>((resolve, reject) => {
      let done = false;
      const finish = () => {
        if (done) return false;
        done = true;
        signal?.removeEventListener("abort", abort);
        task.controller.signal.removeEventListener("abort", abort);
        if (--task.users === 0) {
          if (this.jobs.get(id) === task) this.jobs.delete(id);
          task.controller.abort();
        }
        return true;
      };
      const abort = () => {
        if (finish()) reject(new DOMException("Cancelled", "AbortError"));
      };
      signal?.addEventListener("abort", abort, { once: true });
      task.controller.signal.addEventListener("abort", abort, { once: true });
      task.promise.then(
        (value) => {
          if (finish()) resolve(value as T);
        },
        (error) => {
          if (finish()) reject(error);
        },
      );
    });
  }
  cancel(scope: string) {
    for (const [id, job] of this.jobs)
      if (job.scope === scope) {
        this.jobs.delete(id);
        job.controller.abort();
      }
  }
}
export function isReadCancelled(error: unknown) {
  return (
    (error instanceof DOMException && error.name === "AbortError") ||
    String(error).includes("READ_CANCELLED")
  );
}
