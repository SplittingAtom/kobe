import type { ScheduleRecurrence } from "@kobe/protocol";
import { nextOccurrence } from "../schedules/recurrence.js";

/**
 * What to do with a due schedule (KOBE-174, D32). After downtime several occurrences can be
 * overdue; the coordinator's rule is that **at most one** fires (the latest one) and only when it
 * lies inside the grace window; everything older is skipped and recorded. Never a burst.
 */
export interface FirePlan {
  /** The occurrence to run, or null when none is recent enough (all are skipped). */
  readonly fireAt: Date | null;
  /** Occurrences before `fireAt` (or all of them when it is null) were skipped. */
  readonly skippedBefore: boolean;
  /** The next occurrence after `now`; null when the recurrence never fires again. */
  readonly next: Date | null;
}

export interface FireInput {
  readonly recurrence: ScheduleRecurrence;
  readonly tz: string;
  /** The schedule's `next_due_at`: its oldest unfired occurrence. */
  readonly dueAt: Date;
  readonly now: Date;
  readonly graceMs: number;
}

/** Bound on the walk: the grace window holds at most grace / 15 min occurrences (contract minimum). */
const MAX_STEPS = 5_000;

export function planFire(input: FireInput): FirePlan {
  const { recurrence, tz, dueAt, now, graceMs } = input;
  const next = nextOccurrence(recurrence, tz, now);
  const windowStart = new Date(now.getTime() - graceMs);
  // The first candidate: the due occurrence itself when it is recent, else the first one inside the window.
  const first =
    dueAt >= windowStart
      ? dueAt
      : nextOccurrence(recurrence, tz, new Date(windowStart.getTime() - 1));
  if (first === null || first > now) return { fireAt: null, skippedBefore: true, next };
  let latest = first;
  for (let i = 0; i < MAX_STEPS; i += 1) {
    const following = nextOccurrence(recurrence, tz, latest);
    if (following === null || following > now) break;
    latest = following;
  }
  return { fireAt: latest, skippedBefore: latest.getTime() > dueAt.getTime(), next };
}
