import { RETENTION_GRACE_DAYS, RETENTION_PERIODS, type RetentionPeriod } from "@kobe/db";
import { z } from "zod";
import { TRASH_RETENTION_DAYS } from "../threads/schemas.js";

/**
 * Retention periods (spec D18): a team keeps threads 30 days, 90 days, 1 year or forever, within
 * the install maximum. Pure helpers, shared by the API, the console and the nightly job.
 */
export { RETENTION_GRACE_DAYS, RETENTION_PERIODS, TRASH_RETENTION_DAYS, type RetentionPeriod };

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

/** Parses a stored value; anything unexpected keeps data (forever) rather than purging it. */
export function parsePeriod(value: string | null | undefined): RetentionPeriod {
  const parsed = retentionPeriodSchema.safeParse(value);
  return parsed.success ? parsed.data : DEFAULT_PERIOD;
}

const DAY_MS = 86_400_000;

/**
 * One layer of the setting (the team's period or the install maximum) with its grace period (user
 * decision 2026-10-04): a shortening waits `RETENTION_GRACE_DAYS` as `pending` before it applies;
 * a lengthening applies at once.
 */
export interface Layer {
  /** In force (until `pendingAt`). */
  readonly applied: RetentionPeriod;
  readonly pending: RetentionPeriod | null;
  readonly pendingAt: Date | null;
}

export const FOREVER_LAYER: Layer = { applied: DEFAULT_PERIOD, pending: null, pendingAt: null };

/** The layer as of `now`: a pending change whose date has come is applied. */
export function settle(layer: Layer, now: Date): Layer {
  if (layer.pending !== null && layer.pendingAt !== null && layer.pendingAt <= now) {
    return { applied: layer.pending, pending: null, pendingAt: null };
  }
  return layer;
}

/** What the layer will be once its pending change applies (what admins chose). */
export function target(layer: Layer): RetentionPeriod {
  return layer.pending ?? layer.applied;
}

export type LayerChange =
  | { readonly kind: "unchanged"; readonly layer: Layer }
  /** Same length or longer than what applies: at once (a pending shortening is dropped). */
  | { readonly kind: "immediate"; readonly layer: Layer }
  /** Shorter: applies at `layer.pendingAt`. */
  | { readonly kind: "scheduled"; readonly layer: Layer };

export function changeLayer(current: Layer, next: RetentionPeriod, now: Date): LayerChange {
  const layer = settle(current, now);
  if (next === target(layer)) return { kind: "unchanged", layer };
  if (withinMaximum(layer.applied, next)) {
    return { kind: "immediate", layer: { applied: next, pending: null, pendingAt: null } };
  }
  const pendingAt = new Date(now.getTime() + RETENTION_GRACE_DAYS * DAY_MS);
  return { kind: "scheduled", layer: { applied: layer.applied, pending: next, pendingAt } };
}

/** The period the job applies at `at`: the shorter of both layers as of then. */
export function effectiveAt(team: Layer, maximum: Layer, at: Date): RetentionPeriod {
  return shorterPeriod(settle(team, at).applied, settle(maximum, at).applied);
}

export interface Upcoming {
  readonly period: RetentionPeriod;
  readonly effectiveAt: Date;
}

/** The next time the applied period gets shorter (for the banner and the email), if any. */
export function upcomingShortening(team: Layer, maximum: Layer, now: Date): Upcoming | null {
  const times = [team.pendingAt, maximum.pendingAt]
    .filter((t): t is Date => t !== null && t > now)
    .sort((a, b) => a.getTime() - b.getTime());
  let before = effectiveAt(team, maximum, now);
  for (const at of times) {
    const after = effectiveAt(team, maximum, at);
    if (rank(after) < rank(before)) return { period: after, effectiveAt: at };
    before = after;
  }
  return null;
}

export interface RetentionView {
  /** What the team admins chose (in force or pending). */
  readonly period: RetentionPeriod;
  /** The install maximum as chosen (in force or pending). */
  readonly maximum: RetentionPeriod;
  /** What the nightly job applies now. */
  readonly effective: RetentionPeriod;
  /** The team's own shortening waiting out its grace period (team admins can cancel it). */
  readonly pending: { readonly period: RetentionPeriod; readonly effectiveAt: string } | null;
  /** The next shortening of what applies, from either layer (the banner). */
  readonly upcoming: { readonly period: RetentionPeriod; readonly effectiveAt: string } | null;
}

export function retentionView(team: Layer, maximum: Layer, now: Date): RetentionView {
  const t = settle(team, now);
  const m = settle(maximum, now);
  const upcoming = upcomingShortening(t, m, now);
  return {
    period: target(t),
    maximum: target(m),
    effective: effectiveAt(t, m, now),
    pending:
      t.pending !== null && t.pendingAt !== null
        ? { period: t.pending, effectiveAt: t.pendingAt.toISOString() }
        : null,
    upcoming: upcoming
      ? { period: upcoming.period, effectiveAt: upcoming.effectiveAt.toISOString() }
      : null,
  };
}
