import { sql } from "@kobe/db";
import type { SemanticMemoryStatus } from "@kobe/protocol";
import type { Location } from "./location.js";

/**
 * "Stale" (KOBE-386, for the KOBE-385 consoles; threshold `stale_after_days` from KOBE-381,
 * default 90): an active item that neither changed (`updated_at`) nor is dated (`as_of`, when set)
 * within the last `days` days. A review label only: no sweep archives, evicts or deletes by it.
 * Dates compare in UTC; `as_of` is a calendar date, fresh on the cutoff day itself.
 */

const DAY_MS = 86_400_000;

export interface StaleFields {
  readonly status: SemanticMemoryStatus;
  readonly updated_at: Date | string;
  readonly as_of: string | null;
}

export function isStale(item: StaleFields, days: number, now: Date = new Date()): boolean {
  if (item.status !== "active") return false;
  const cutoff = now.getTime() - days * DAY_MS;
  if (new Date(item.updated_at).getTime() >= cutoff) return false;
  if (item.as_of !== null && item.as_of >= new Date(cutoff).toISOString().slice(0, 10))
    return false;
  return true;
}

/** The same rule over item `i` of `loc`, for the list filter. */
export function staleSql(loc: Location, days: number) {
  const cutoff = sql`(now() - make_interval(days => ${days}))`;
  return sql`(i.status = 'active' AND i.updated_at < ${cutoff}
    AND (${loc.asOf} IS NULL OR ${loc.asOf} < (${cutoff} AT TIME ZONE 'UTC')::date))`;
}
