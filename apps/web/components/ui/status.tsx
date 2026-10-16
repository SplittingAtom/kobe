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

/** Classes of the motion that stops under `prefers-reduced-motion` (status.module.css). */
export const PULSE_CLASS = styles.pulse ?? "";

/**
 * A small status dot. `label` is read by screen readers (the dot itself is decoration); without
 * one, the dot sits next to text that already says the state. `pulse` animates it softly, never
 * under `prefers-reduced-motion`.
 */
export function StatusDot({
  tone,
  pulse = false,
  label,
  className,
}: {
  readonly tone: StatusTone;
  readonly pulse?: boolean;
  readonly label?: string | undefined;
  readonly className?: string | undefined;
}) {
  return (
    <>
      <span
        aria-hidden
        data-status-dot={tone}
        data-pulse={pulse || undefined}
        className={cn(styles.dot, toneClass(tone), pulse && styles.pulse, className)}
      />
      {label && <span className={styles.visuallyHidden}>{label}</span>}
    </>
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
