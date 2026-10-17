import type { ComponentProps } from "react";
import { cn } from "../../../lib/utils";

export type BadgeTone = "neutral" | "running" | "attention" | "failed" | "done" | "accent";

/** The status colours (KOBE-301): text on its tint or the panel keeps AA in both themes. */
const TONES: Readonly<Record<BadgeTone, string>> = {
  neutral: "border-console-border bg-console-panel text-console-fg",
  running: "border-transparent bg-status-running-bg text-status-running",
  attention: "border-transparent bg-status-attention-bg text-status-attention",
  failed: "border-transparent bg-status-failed-bg text-status-failed",
  done: "border-console-border bg-console-panel text-status-done",
  accent: "border-transparent bg-status-accent text-status-accent-fg",
};

/** A short status or label ("Pending", "Suspended"). Its text says what it means, not its colour. */
export function Badge({
  tone = "neutral",
  className,
  ...props
}: ComponentProps<"span"> & { readonly tone?: BadgeTone }) {
  return (
    <span
      data-slot="console-badge"
      data-tone={tone}
      className={cn(
        "box-border inline-flex items-center rounded-full border px-2 py-0.5 text-xs leading-4 font-medium whitespace-nowrap",
        TONES[tone],
        className,
      )}
      {...props}
    />
  );
}
