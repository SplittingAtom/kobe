"use client";

/** How an execution ended, in words (KOBE-465; statuses NB15, save errors NB11). */
import type { Execution } from "../../lib/notebooks/executions";

const STATUS: Readonly<Record<string, string>> = {
  interrupted: "Interrupted.",
  timeout: "Stopped: it ran past its time limit.",
  restarted: "Stopped: the kernel restarted.",
  failed: "The sandbox could not run this.",
};

const SAVE_ERROR: Readonly<Record<string, string>> = {
  version_conflict: "the notebook changed meanwhile",
  cell_not_found: "the cell is no longer in the saved notebook",
  read_only: "the file is read-only",
};

/** What to say about an execution beyond its outputs; null: nothing (running, or plain ok). */
export function executionNote(exec: Execution, notebook: boolean): string | null {
  const end = exec.finished;
  if (end === undefined) return null;
  const parts: string[] = [];
  const status = STATUS[end.status];
  if (status) parts.push(status);
  if (end.truncated) parts.push("Some output was cut (too much to keep).");
  if (notebook && end.saved === null && end.status !== "failed") {
    const why = end.saveError ? (SAVE_ERROR[end.saveError] ?? end.saveError) : null;
    parts.push(
      why ? `The outputs were not saved to the notebook: ${why}.` : "The outputs were not saved.",
    );
  }
  return parts.length === 0 ? null : parts.join(" ");
}

export function ExecutionNote({
  exec,
  notebook,
}: {
  readonly exec: Execution;
  readonly notebook: boolean;
}) {
  const running = exec.finished === undefined;
  const text = running ? "Running…" : executionNote(exec, notebook);
  if (text === null) return null;
  return (
    <p role="status" className="text-muted-foreground text-xs" data-kobe-exec-status="">
      {exec.origin === "agent" ? `Agent run: ${text}` : text}
    </p>
  );
}
