import { cn } from "../../lib/utils";
import styles from "./status.module.css";

/**
 * The status tones (KOBE-301), one per colour in app/theme.css: running (green), attention
 * (amber: an approval or an interrupted run needs the member), failed (red), done (muted green)
 * and idle (grey).
 */
export type StatusTone = "running" | "attention" | "failed" | "done" | "idle";

/** The CSS-module class that sets `color` to a tone (icons and dots use `currentColor`). */
export const toneClass = (tone: StatusTone): string => styles[tone] ?? "";

/**
 * A small status dot: decoration, so it always sits by text or a description that says the state.
 * `pulse` animates it softly, never under `prefers-reduced-motion`.
 */
export function StatusDot({
  tone,
  pulse = false,
  className,
}: {
  readonly tone: StatusTone;
  readonly pulse?: boolean;
  readonly className?: string | undefined;
}) {
  return (
    <span
      aria-hidden
      data-status-dot={tone}
      data-pulse={pulse || undefined}
      className={cn(styles.dot, toneClass(tone), pulse && styles.pulse, className)}
    />
  );
}

/** The thread header's state badge: the label in the tone's colour on its tint, with a dot. */
export function StatusBadge({
  tone,
  pulse = false,
  children,
}: {
  readonly tone: StatusTone;
  readonly pulse?: boolean;
  readonly children: string;
}) {
  return (
    <span data-status-badge={tone} className={cn(styles.badge, toneClass(tone))}>
      {tone !== "idle" && <StatusDot tone={tone} pulse={pulse} />}
      {children}
    </span>
  );
}
