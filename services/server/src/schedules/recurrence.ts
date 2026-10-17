import type { ScheduleRecurrence } from "@kobe/protocol";

/**
 * Recurrence engine (KOBE-173, spec D32): the cron a recurrence means and its next occurrence in
 * the schedule's IANA zone, built on `Intl` (no dependency). Input is contract-valid (strict
 * 5-field numeric cron, see `parseCron` in @kobe/protocol); this module reads all five fields.
 *
 * DST rules (the documented contract):
 * - Spring-forward gap: a local time that does not exist that day fires at the first valid
 *   instant after the gap (02:30 on a day 02:00 jumps to 03:00 fires at 03:00 local).
 * - Fall-back overlap: a local time that occurs twice fires once, at its FIRST occurrence.
 * - Day of month and day of week both restricted: either matches (classic cron).
 */

const WEEKDAY_NUMBER = { sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6 } as const;
/** Farthest we look: Feb 29 is at most 8 years away (a century year that is not a leap year). */
const MAX_SEARCH_DAYS = 366 * 8 + 3;
const DAY_MS = 86_400_000;

/** The cron expression a recurrence stands for (stored in `schedules.cron`). */
export function recurrenceToCron(recurrence: ScheduleRecurrence): string {
  if (recurrence.kind === "cron") return recurrence.expr;
  const [hh = "0", mm = "0"] = recurrence.at.split(":");
  const clock = `${Number(mm)} ${Number(hh)}`;
  if (recurrence.kind === "daily") return `${clock} * * *`;
  if (recurrence.kind === "weekdays") return `${clock} * * 1-5`;
  const days = recurrence.days.map((d) => WEEKDAY_NUMBER[d]).sort((a, b) => a - b);
  return `${clock} * * ${days.join(",")}`;
}

interface CronSpec {
  readonly minutes: readonly number[];
  readonly hours: readonly number[];
  readonly dom: ReadonlySet<number>;
  readonly months: ReadonlySet<number>;
  readonly dow: ReadonlySet<number>;
  readonly domRestricted: boolean;
  readonly dowRestricted: boolean;
}

function expandField(text: string, min: number, max: number): number[] {
  const values = new Set<number>();
  for (const item of text.split(",")) {
    const [range = "", step] = item.split("/");
    const by = step === undefined ? 1 : Number(step);
    const [loText, hiText] = range === "*" ? [String(min), String(max)] : range.split("-");
    const lo = Number(loText);
    const hi = hiText !== undefined ? Number(hiText) : step === undefined ? lo : max;
    for (let v = lo; v <= hi; v += by) values.add(v);
  }
  return [...values].sort((a, b) => a - b);
}

function parseSpec(cron: string): CronSpec {
  const [min = "", hour = "", dom = "", month = "", dow = ""] = cron.split(" ");
  const days = expandField(dow, 0, 7).map((d) => d % 7);
  return {
    minutes: expandField(min, 0, 59),
    hours: expandField(hour, 0, 23),
    dom: new Set(expandField(dom, 1, 31)),
    months: new Set(expandField(month, 1, 12)),
    dow: new Set(days),
    domRestricted: !dom.startsWith("*"),
    dowRestricted: !dow.startsWith("*"),
  };
}

const formatters = new Map<string, Intl.DateTimeFormat>();
function formatter(tz: string): Intl.DateTimeFormat {
  let f = formatters.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", {
      timeZone: tz,
      hourCycle: "h23",
      year: "numeric",
      month: "numeric",
      day: "numeric",
      hour: "numeric",
      minute: "numeric",
      second: "numeric",
    });
    formatters.set(tz, f);
  }
  return f;
}

/** The wall clock in `tz` at `instant`, as if it were UTC (ms): comparable with `Date.UTC(...)`. */
export function wallMs(tz: string, instantMs: number): number {
  const parts: Record<string, number> = {};
  for (const p of formatter(tz).formatToParts(new Date(instantMs))) {
    if (p.type !== "literal") parts[p.type] = Number(p.value);
  }
  return Date.UTC(
    parts.year ?? 1970,
    (parts.month ?? 1) - 1,
    parts.day ?? 1,
    parts.hour ?? 0,
    parts.minute ?? 0,
    parts.second ?? 0,
  );
}

const offsetMs = (tz: string, instantMs: number): number =>
  wallMs(tz, instantMs) - Math.floor(instantMs / 1000) * 1000;

/**
 * The instant a local wall time (given as UTC-style ms) happens: the first occurrence if it
 * repeats; if it does not exist, the first instant after the gap.
 */
export function wallToInstant(tz: string, wall: number): number {
  const before = offsetMs(tz, wall - DAY_MS);
  const after = offsetMs(tz, wall + DAY_MS);
  const valid = [before, after]
    .map((off) => wall - off)
    .filter((t) => wallMs(tz, t) === wall)
    .sort((a, b) => a - b);
  const first = valid[0];
  if (first !== undefined) return first;
  // Gap: find the transition, the first second whose offset is the new (`after`) one.
  let lo = wall - before - DAY_MS;
  let hi = wall - after + DAY_MS;
  while (hi - lo > 1000) {
    const mid = Math.floor((lo + hi) / 2000) * 1000;
    if (offsetMs(tz, mid) === after) hi = mid;
    else lo = mid;
  }
  return hi;
}

function dayMatches(spec: CronSpec, y: number, m: number, d: number): boolean {
  if (!spec.months.has(m)) return false;
  const dowMatch = spec.dow.has(new Date(Date.UTC(y, m - 1, d)).getUTCDay());
  const domMatch = spec.dom.has(d);
  if (spec.domRestricted && spec.dowRestricted) return domMatch || dowMatch;
  return domMatch && dowMatch;
}

/**
 * The first occurrence strictly after `after`, evaluated in `tz`; null if none within ~8 years
 * (impossible dates such as Feb 31).
 */
export function nextOccurrence(
  recurrence: ScheduleRecurrence,
  tz: string,
  after: Date,
): Date | null {
  const spec = parseSpec(recurrenceToCron(recurrence));
  const afterMs = after.getTime();
  const startDay = Math.floor(wallMs(tz, afterMs) / DAY_MS) - 1;
  for (let i = 0; i < MAX_SEARCH_DAYS; i++) {
    const day = new Date((startDay + i) * DAY_MS);
    const [y, m, d] = [day.getUTCFullYear(), day.getUTCMonth() + 1, day.getUTCDate()];
    if (!dayMatches(spec, y, m, d)) continue;
    const instants = spec.hours
      .flatMap((h) => spec.minutes.map((min) => wallToInstant(tz, Date.UTC(y, m - 1, d, h, min))))
      .filter((t) => t > afterMs)
      .sort((a, b) => a - b);
    if (instants[0] !== undefined) return new Date(instants[0]);
  }
  return null;
}
