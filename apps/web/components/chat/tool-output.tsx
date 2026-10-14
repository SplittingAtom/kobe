"use client";

import { useEffect, useState } from "react";
import { cn } from "../../lib/utils";
import { useKobeExtras } from "./kobe-runtime";

/**
 * A tool output read in full (KOBE-208): the entry list trims one over 64 KB to a preview, and an
 * offloaded entry has none; either is read from the output route the first time it is shown. A
 * failed read (an error answer or a rejected request) says so and is tried again on Retry or the
 * next time the block opens.
 */
export type FullOutput =
  | { readonly status: "idle" | "loading" | "failed" }
  | {
      readonly status: "ready";
      readonly text: string;
      readonly isError: boolean;
      readonly truncated: boolean;
    };

export function useFullOutput(
  entryId: string | undefined,
  open: boolean,
): { readonly output: FullOutput; retry(): void } {
  const controller = useKobeExtras()?.controller;
  const [output, setOutput] = useState<FullOutput>({ status: "idle" });
  const status = output.status;
  useEffect(() => {
    if (!open) {
      if (status === "failed") setOutput({ status: "idle" });
      return;
    }
    if (status !== "idle" || entryId === undefined || !controller) return;
    setOutput({ status: "loading" });
    const request = controller.toolOutput(entryId);
    if (!request) {
      setOutput({ status: "failed" });
      return;
    }
    request.then(
      (res) =>
        setOutput(
          res.ok
            ? {
                status: "ready",
                text: res.data.text,
                isError: res.data.isError,
                truncated: res.data.truncated,
              }
            : { status: "failed" },
        ),
      () => setOutput({ status: "failed" }),
    );
  }, [open, status, entryId, controller]);
  return { output, retry: () => setOutput({ status: "idle" }) };
}

export const PRE =
  "bg-muted/50 my-1 max-h-64 overflow-auto rounded-md p-2 font-mono text-xs break-words whitespace-pre-wrap";

/** A tool's output (or error) as text; `truncated` marks that more exists than is shown. */
export function Output({
  text,
  error,
  truncated,
}: {
  readonly text: string;
  readonly error: boolean;
  readonly truncated: boolean;
}) {
  return (
    <>
      <p className="text-muted-foreground m-0 text-xs font-medium">{error ? "Error" : "Output"}</p>
      <pre aria-label="Output" className={cn(PRE, error && "text-destructive")}>
        {text}
        {truncated ? "…" : ""}
      </pre>
    </>
  );
}

/** Where a full read stands while it isn't ready: loading, or failed with a way to retry. */
export function FullOutputStatus({
  output,
  retry,
}: {
  readonly output: FullOutput;
  retry(): void;
}) {
  if (output.status === "failed") {
    return (
      <p role="alert" className="text-destructive m-0 flex items-center gap-2 text-xs">
        The full output could not be loaded.
        <button type="button" className="px-2 py-0.5 text-xs" onClick={retry}>
          Retry
        </button>
      </p>
    );
  }
  if (output.status === "ready") return null;
  return (
    <p role="status" className="text-muted-foreground m-0 text-xs">
      Loading the full output…
    </p>
  );
}
