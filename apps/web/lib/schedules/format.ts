/** Words and defaults for schedules: presets, the user's time zone, and local-time display. */
import type { SCHEDULE_WEEKDAYS, ScheduleRecurrence } from "@kobe/protocol";

export type PresetKind = ScheduleRecurrence["kind"];

export const PRESET_LABELS: Readonly<Record<PresetKind, string>> = {
  daily: "Every day",
  weekdays: "Weekdays (Mon-Fri)",
  weekly: "Weekly",
  cron: "Custom cron",
};

export const WEEKDAY_LABELS: Readonly<Record<(typeof SCHEDULE_WEEKDAYS)[number], string>> = {
  mon: "Mon",
  tue: "Tue",
  wed: "Wed",
  thu: "Thu",
  fri: "Fri",
  sat: "Sat",
  sun: "Sun",
};

/** The browser's IANA zone, or UTC when it cannot say. */
export function browserTimeZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
}

function supportedZones(): string[] {
  try {
    return Intl.supportedValuesOf("timeZone");
  } catch {
    return [];
  }
}

/** Zones the browser knows, with `current` included so an existing value always has an option. */
export function timeZoneOptions(current: string): readonly string[] {
  const zones = supportedZones();
  return zones.includes(current) ? zones : [current, ...zones];
}

export function describeRecurrence(r: ScheduleRecurrence): string {
  switch (r.kind) {
    case "daily":
      return `Every day at ${r.at}`;
    case "weekdays":
      return `Weekdays at ${r.at}`;
    case "weekly":
      return `${r.days.map((d) => WEEKDAY_LABELS[d]).join(", ")} at ${r.at}`;
    case "cron":
      return `Cron ${r.expr}`;
  }
}

/** A moment in `tz` (the schedule's zone, which may differ from the browser's), with the zone. */
export function formatInZone(iso: string | null, tz: string): string {
  if (iso === null) return "—";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "—";
  try {
    return `${date.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short", timeZone: tz })} (${tz})`;
  } catch {
    return date.toISOString();
  }
}
