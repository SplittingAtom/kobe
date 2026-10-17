import { CircleAlertIcon, CircleCheckIcon, InfoIcon, TriangleAlertIcon } from "lucide-react";
import type { ComponentProps, ReactNode } from "react";
import { cn } from "../../../lib/utils";

export type NoticeTone = "info" | "success" | "warn" | "error";

/** The status colours (KOBE-301, app/theme.css): each keeps AA on its tint in both themes. */
const TONES: Readonly<Record<NoticeTone, { readonly box: string; readonly icon: string }>> = {
  info: { box: "border-status-accent bg-console-panel", icon: "text-status-accent" },
  success: { box: "border-status-running bg-status-running-bg", icon: "text-status-running" },
  warn: { box: "border-status-attention bg-status-attention-bg", icon: "text-status-attention" },
  error: { box: "border-status-failed bg-status-failed-bg", icon: "text-status-failed" },
};

const ICONS = {
  info: InfoIcon,
  success: CircleCheckIcon,
  warn: TriangleAlertIcon,
  error: CircleAlertIcon,
} as const;

/**
 * A message about the page or an action: info, success, a warning, or an error. Colour is never
 * the only cue (an icon matches the tone). An error is announced at once (`role="alert"`); pass
 * `role` to announce others (`status`) or to silence one that was on screen from the start. A
 * success after an action belongs in a live region that was already on the page (see
 * `MutationStatus`). Other div props (id, data-*, aria-*, ref) pass through.
 */
export function Notice({
  tone = "info",
  title,
  actions,
  children,
  role,
  className,
  ...props
}: Omit<ComponentProps<"div">, "title"> & {
  readonly tone?: NoticeTone;
  readonly title?: ReactNode;
  /** Buttons or links for what to do about it, after the text. */
  readonly actions?: ReactNode;
}) {
  const Icon = ICONS[tone];
  return (
    <div
      data-slot="console-notice"
      data-tone={tone}
      role={role ?? (tone === "error" ? "alert" : undefined)}
      className={cn(
        "my-2 box-border flex gap-2 border-0 border-l-4 px-3 py-2 text-console-fg",
        TONES[tone].box,
        className,
      )}
      {...props}
    >
      <Icon aria-hidden className={cn("mt-0.5 size-4 shrink-0", TONES[tone].icon)} />
      <div className="min-w-0 flex-1 [&_p]:my-1">
        {title && <p className="font-semibold">{title}</p>}
        {children}
        {actions && <div className="mt-2 flex flex-wrap gap-2">{actions}</div>}
      </div>
    </div>
  );
}
