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

/** A timestamp people can read, with the exact value for machines. */
export function DateTime({ value }: { readonly value: string | null | undefined }) {
  if (!value) return <>—</>;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return <>—</>;
  return (
    <time dateTime={value} title={date.toISOString()}>
      {date.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" })}
    </time>
  );
}

/** Asks before a change that can't be undone from here (native dialog: keyboard accessible). */
export function confirmed(message: string): boolean {
  return typeof window !== "undefined" && window.confirm(message);
}
