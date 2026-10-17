"use client";

import type { ReactNode } from "react";
import { ErrorNotice } from "./error-notice";
import type { ResourceState } from "./use-resource";

/** Loading / error / data for one resource. */
export function ResourceView<T>({
  state,
  label,
  children,
}: {
  readonly state: ResourceState<T>;
  /** What is loading, for the status message: "users". */
  readonly label: string;
  readonly children: (data: T) => ReactNode;
}) {
  if (state.status === "loading") return <p role="status">Loading {label}…</p>;
  if (state.status === "error") return <ErrorNotice error={state.error} />;
  return <>{children(state.data)}</>;
}

/**
 * "Oct 17, 05:26" in the viewer's locale: month, day and a 24-hour time, with the year only when
 * it is not `now`'s (KOBE-306). For dense tables, where the full form would wrap.
 */
export function compactDateTime(date: Date, now: Date = new Date()): string {
  return date.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    ...(date.getFullYear() === now.getFullYear() ? {} : { year: "numeric" }),
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  });
}

/**
 * A timestamp people can read, with the exact value for machines. `precise` shows seconds and
 * the time zone (the audit log, where times are compared with exports and other logs). `compact`
 * is for dense tables (KOBE-306): "Oct 17, 05:26" on one line, the full date, time and zone in
 * its tooltip.
 */
export function DateTime({
  value,
  precise = false,
  compact = false,
}: {
  readonly value: string | null | undefined;
  readonly precise?: boolean;
  readonly compact?: boolean;
}) {
  if (!value) return <>—</>;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return <>—</>;
  if (compact) {
    return (
      <time
        dateTime={value}
        title={date.toLocaleString(undefined, { dateStyle: "full", timeStyle: "long" })}
        className="whitespace-nowrap"
      >
        {compactDateTime(date)}
      </time>
    );
  }
  return (
    <time dateTime={value} title={date.toISOString()}>
      {date.toLocaleString(undefined, {
        dateStyle: "medium",
        timeStyle: precise ? "long" : "short",
      })}
    </time>
  );
}
