/** Formatting and time ranges for the usage pages (KOBE-43). Pure; unit-tested. */

export const USAGE_RANGES = [
  { id: "24h", label: "Last 24 hours", ms: 24 * 3600 * 1000 },
  { id: "7d", label: "Last 7 days", ms: 7 * 24 * 3600 * 1000 },
  { id: "30d", label: "Last 30 days", ms: 30 * 24 * 3600 * 1000 },
  { id: "90d", label: "Last 90 days", ms: 90 * 24 * 3600 * 1000 },
] as const;

export type UsageRangeId = (typeof USAGE_RANGES)[number]["id"];

export function rangeQuery(id: UsageRangeId, now = new Date()): { from: string; to: string } {
  const range = USAGE_RANGES.find((r) => r.id === id) ?? USAGE_RANGES[2];
  return { from: new Date(now.getTime() - range.ms).toISOString(), to: now.toISOString() };
}

/** 950 → "950", 12 345 → "12.3k", 4 200 000 → "4.2M". */
export function formatTokens(n: number): string {
  if (!Number.isFinite(n)) return "—";
  const abs = Math.abs(n);
  if (abs < 1_000) return String(Math.round(n));
  if (abs < 1_000_000) return `${trim(n / 1_000)}k`;
  if (abs < 1_000_000_000) return `${trim(n / 1_000_000)}M`;
  return `${trim(n / 1_000_000_000)}B`;
}

function trim(v: number): string {
  return (Math.abs(v) < 100 ? v.toFixed(1) : v.toFixed(0)).replace(/\.0$/, "");
}

/** Dollars: cents for $1 and up, more precision for small amounts ("$0.0042"). */
export function formatUsd(n: number): string {
  if (!Number.isFinite(n)) return "—";
  if (n === 0) return "$0.00";
  if (Math.abs(n) >= 1) {
    return `$${n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  }
  if (Math.abs(n) >= 0.01) return `$${n.toFixed(2)}`;
  return `$${n.toPrecision(2).replace(/0+$/, "")}`;
}

/** A bucket's start for an axis label: "14:00" for hours, "Oct 3" for days (UTC). */
export function bucketLabel(iso: string, bucket: "hour" | "day"): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return bucket === "hour"
    ? `${String(d.getUTCHours()).padStart(2, "0")}:00`
    : d.toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
}

/**
 * Fills the buckets the server skipped (no calls) with zeros, so bars line up with time.
 * Capped at `max` buckets (the newest are kept).
 */
export function fillSeries<T extends { readonly t: string }>(
  points: readonly T[],
  range: { readonly from: string; readonly to: string; readonly bucket: "hour" | "day" },
  zero: (t: string) => T,
  max = 400,
): T[] {
  const step = range.bucket === "hour" ? 3600_000 : 86_400_000;
  const start = new Date(range.from);
  if (range.bucket === "hour") start.setUTCMinutes(0, 0, 0);
  else start.setUTCHours(0, 0, 0, 0);
  const end = new Date(range.to).getTime();
  const byTime = new Map(points.map((p) => [new Date(p.t).getTime(), p]));
  const out: T[] = [];
  for (let t = start.getTime(); t < end; t += step) {
    out.push(byTime.get(t) ?? zero(new Date(t).toISOString()));
  }
  return out.slice(-max);
}
