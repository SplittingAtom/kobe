/**
 * Per-frame budgets of Kobe's host bridge (KOBE-437, spec T4; review LOW-1 to LOW-3).
 */

/** A sliding one-second window: `take()` is false once `limit` events fell in the last second. */
export function windowCounter(limit: number, now: () => number): { take(): boolean } {
  const recent: number[] = [];
  return {
    take() {
      const t = now();
      while (recent.length > 0 && t - (recent[0] as number) >= 1000) recent.shift();
      if (recent.length >= limit) return false;
      recent.push(t);
      return true;
    },
  };
}

/**
 * A frame's tool calls run one at a time (the server validates one call per member at a time,
 * review LOW-3); at most `capacity` are admitted, running or waiting. `run` resolves when its
 * task does, or `undefined` at once when the queue is full.
 */
export function callQueue(capacity: number): {
  run<T>(task: () => Promise<T>): Promise<T> | undefined;
} {
  let admitted = 0;
  let tail: Promise<unknown> = Promise.resolve();
  return {
    run(task) {
      if (admitted >= capacity) return undefined;
      admitted += 1;
      const result = tail.then(task);
      tail = result.then(
        () => undefined,
        () => undefined,
      );
      return result.finally(() => {
        admitted -= 1;
      });
    },
  };
}

/** A cheap upper bound of a message's size before it is serialized (review LOW-2). */
export function roughlyTooLarge(data: unknown, maxBytes: number): boolean {
  if (typeof data === "string") return data.length > maxBytes;
  if (data instanceof ArrayBuffer) return data.byteLength > maxBytes;
  if (ArrayBuffer.isView(data)) return data.byteLength > maxBytes;
  return false;
}
