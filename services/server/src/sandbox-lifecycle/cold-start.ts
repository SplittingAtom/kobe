/**
 * Cold-start measurement (KOBE-25; spec D14 and Gate 1: hibernated → first token p50 ≤ 3 s,
 * p95 ≤ 8 s over 20 trials). Each trial hibernates the sandbox, waits until it is fully down (no
 * pod), then times one probe from "user acts" to "answer". The probe is pluggable:
 *
 * - `connected`: until the woken sandbox's agent holds a wire connection again.
 * - `pi` (default today): until Pi answers `get_state` on a thread (agent connected, Pi spawned).
 * - `first-token` (KOBE-40/41): until the first `text.delta` of a real run — needs a model, so it
 *   is not implemented yet; register it here when the model gateway lands (see the ledger).
 *
 * The probe's milestones are recorded for every trial so the gap to first token stays visible.
 */

export interface TrialMilestones {
  /** ms from the trial's start (the command that wakes the sandbox) to each milestone. */
  readonly [milestone: string]: number | undefined;
}

export interface Trial {
  readonly index: number;
  /** The probe's own end point (what the percentiles are computed over). */
  readonly totalMs: number;
  readonly milestones: TrialMilestones;
}

export interface Percentiles {
  readonly n: number;
  readonly p50: number;
  readonly p95: number;
  readonly max: number;
  readonly min: number;
}

/** Nearest-rank percentile (p95 of 20 samples is the 19th smallest). */
export function percentile(sorted: readonly number[], p: number): number {
  if (sorted.length === 0) return Number.NaN;
  const rank = Math.ceil((p / 100) * sorted.length);
  return sorted[Math.min(sorted.length, Math.max(1, rank)) - 1] as number;
}

export function summarize(samples: readonly number[]): Percentiles {
  const sorted = [...samples].sort((a, b) => a - b);
  return {
    n: sorted.length,
    p50: percentile(sorted, 50),
    p95: percentile(sorted, 95),
    min: sorted[0] ?? Number.NaN,
    max: sorted.at(-1) ?? Number.NaN,
  };
}

export interface ColdStartSteps {
  /** Hibernates the sandbox now (forced: the idle time is skipped, the busy checks are not). */
  hibernate(): Promise<void>;
  /** Resolves once the sandbox has no pod left (fully hibernated). */
  waitHibernated(): Promise<void>;
  /** The measured action: wakes the sandbox and resolves with milestones (ms since its start). */
  probe(): Promise<{ readonly totalMs: number; readonly milestones: TrialMilestones }>;
  /** Called after each trial (progress output). */
  onTrial?(trial: Trial): void;
}

export interface ColdStartReport {
  readonly probe: string;
  readonly trials: readonly Trial[];
  readonly total: Percentiles;
  /** Percentiles per milestone (over the trials that recorded it). */
  readonly milestones: Readonly<Record<string, Percentiles>>;
}

export async function runColdStartTrials(
  probe: string,
  trials: number,
  steps: ColdStartSteps,
): Promise<ColdStartReport> {
  const done: Trial[] = [];
  for (let index = 0; index < trials; index++) {
    await steps.hibernate();
    await steps.waitHibernated();
    const { totalMs, milestones } = await steps.probe();
    const trial = { index, totalMs, milestones };
    done.push(trial);
    steps.onTrial?.(trial);
  }
  const names = [...new Set(done.flatMap((t) => Object.keys(t.milestones)))];
  const milestones = Object.fromEntries(
    names.map((name) => [
      name,
      summarize(
        done.map((t) => t.milestones[name]).filter((v): v is number => typeof v === "number"),
      ),
    ]),
  );
  return { probe, trials: done, total: summarize(done.map((t) => t.totalMs)), milestones };
}
