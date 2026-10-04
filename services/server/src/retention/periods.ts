import { RETENTION_PERIODS, type RetentionPeriod } from "@kobe/db";
import { z } from "zod";
import { TRASH_RETENTION_DAYS } from "../threads/schemas.js";

/**
 * Retention periods (spec D18): a team keeps threads 30 days, 90 days, 1 year or forever, within
 * the install maximum. Pure helpers, shared by the API, the console and the nightly job.
 */
export { RETENTION_PERIODS, TRASH_RETENTION_DAYS, type RetentionPeriod };

export const retentionPeriodSchema = z.enum(RETENTION_PERIODS);

/** Days each period keeps a thread after its last activity; null keeps it forever. */
export const PERIOD_DAYS: Readonly<Record<RetentionPeriod, number | null>> = {
  "30d": 30,
  "90d": 90,
  "1y": 365,
  forever: null,
};

/** Ended runs' live events are folded away this long after the run ended (D18). */
export const COMPACTION_DAYS = 7;

/** Default team period and install maximum: keep forever (D18). */
export const DEFAULT_PERIOD: RetentionPeriod = "forever";

function rank(period: RetentionPeriod): number {
  return PERIOD_DAYS[period] ?? Number.POSITIVE_INFINITY;
}

/** The shorter of two periods. */
export function shorterPeriod(a: RetentionPeriod, b: RetentionPeriod): RetentionPeriod {
  return rank(a) <= rank(b) ? a : b;
}

/** Whether `period` is within `maximum` (a team may choose it). */
export function withinMaximum(period: RetentionPeriod, maximum: RetentionPeriod): boolean {
  return rank(period) <= rank(maximum);
}

/** The periods a team may choose under `maximum`, shortest first. */
export function allowedPeriods(maximum: RetentionPeriod): RetentionPeriod[] {
  return RETENTION_PERIODS.filter((p) => withinMaximum(p, maximum));
}

export interface RetentionView {
  /** What the team admins chose (default forever). */
  readonly period: RetentionPeriod;
  /** The install maximum (default forever). */
  readonly maximum: RetentionPeriod;
  /** What the nightly job applies: the shorter of the two. */
  readonly effective: RetentionPeriod;
}

export function retentionView(period: RetentionPeriod, maximum: RetentionPeriod): RetentionView {
  return { period, maximum, effective: shorterPeriod(period, maximum) };
}

/** Parses a stored value; anything unexpected keeps data (forever) rather than purging it. */
export function parsePeriod(value: string | null | undefined): RetentionPeriod {
  const parsed = retentionPeriodSchema.safeParse(value);
  return parsed.success ? parsed.data : DEFAULT_PERIOD;
}
