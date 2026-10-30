/** Percentiles for the perf measurement (KOBE-525): nearest rank, like the cold-start harness. */
export function percentile(sorted: readonly number[], p: number): number {
  if (sorted.length === 0) return Number.NaN;
  const rank = Math.ceil((p / 100) * sorted.length);
  return sorted[Math.min(sorted.length, Math.max(1, rank)) - 1] as number;
}

export interface Summary {
  readonly n: number;
  readonly p50: number;
  readonly p95: number;
}

/** p50/p95 over the finite samples (a metric a visit could not measure is undefined). */
export function summarize(samples: readonly (number | undefined)[]): Summary {
  const sorted = samples
    .filter((v): v is number => typeof v === "number" && Number.isFinite(v))
    .sort((a, b) => a - b);
  return { n: sorted.length, p50: percentile(sorted, 50), p95: percentile(sorted, 95) };
}
