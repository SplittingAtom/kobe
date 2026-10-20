"use client";

import Link from "next/link";
import { useId, type ComponentProps, type MouseEvent, type ReactNode } from "react";
import {
  ariaKeyShortcuts,
  command,
  formatShortcut,
  SHORTCUTS_BOUND,
  type CommandId,
} from "../../lib/shell/commands";
import { isMacPlatform, shortcutsOf } from "../../lib/shell/shortcuts";
import { cn } from "../../lib/utils";
import { Button } from "../ui/button";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "../ui/tooltip";
import styles from "./icon-action.module.css";

/** CE13: the tooltip opens after 300 ms. */
export const TOOLTIP_DELAY_MS = 300;

/**
 * The one tooltip provider for IconActions, mounted at the root of each surface that renders them
 * (the chat app, the agent builder's test pane), so neighbouring icons share Radix's skip-delay:
 * after one tooltip, the next opens at once.
 */
export function IconActionProvider({ children }: { readonly children: ReactNode }) {
  return <TooltipProvider delayDuration={TOOLTIP_DELAY_MS}>{children}</TooltipProvider>;
}

const SIZES = { sm: "size-6 p-1 active:scale-90", md: "size-8" } as const;

// Disabled actions stay hoverable (the tooltip still names them) and focusable; they only look off.
const INERT =
  "aria-disabled:cursor-not-allowed aria-disabled:opacity-50 aria-disabled:active:scale-100";

interface OwnProps {
  /** The registry entry: icon, name, shortcut and (for navigation) href. */
  readonly command: CommandId;
  /** Replaces the command's name when the object matters ("Rename Budget"). */
  readonly label?: string | undefined;
  /** What is new behind this icon ("2 unread"): shows the dot and joins the accessible label. */
  readonly badge?: string | undefined;
  /** With `badge`: a visible count (1–99, then 99+) in place of the dot. */
  readonly count?: number | undefined;
  /** A second tooltip line (why the action is unavailable); also the accessible description. */
  readonly description?: string | undefined;
  /** Overrides the registry's shortcut; `null` shows none. */
  readonly shortcut?: string | null | undefined;
  /** Overrides the registry's href (a URL that depends on the team or the version). */
  readonly href?: string | undefined;
  /** A file download: a plain link the router leaves alone. */
  readonly download?: boolean | undefined;
  /** A `<details>` menu's disclosure. */
  readonly as?: "summary" | undefined;
  readonly size?: keyof typeof SIZES | undefined;
  readonly variant?: "ghost" | "outline" | "default" | "destructive" | undefined;
  readonly side?: "top" | "bottom" | "left" | "right" | undefined;
  /** Replaces the command's icon (the copy action's check mark). */
  readonly children?: ReactNode;
}

export type IconActionProps = OwnProps &
  Omit<ComponentProps<"button">, keyof OwnProps | "aria-label">;

function isInert(disabled: boolean | undefined, ariaDisabled: unknown): boolean {
  return disabled === true || ariaDisabled === true || ariaDisabled === "true";
}

function Badge({ count }: { readonly count: number | undefined }) {
  if (count === undefined) return <span className={styles.dot} data-badge aria-hidden="true" />;
  return (
    <span className={styles.count} data-badge aria-hidden="true">
      {count > 99 ? "99+" : count}
    </span>
  );
}

/**
 * One navigation or action icon (CE13, KOBE-203): a lucide icon with a radix tooltip that names the
 * action and shows its shortcut. The name is also the accessible label; a dot badge marks a panel
 * with something new. Content (thread titles, names, markers, tables) stays text, never this.
 *
 * Props pass through, so assistant-ui primitives can render it with `asChild`, under one rule on
 * every path: the action's own label, `data-command` and shortcut win over passed props, and a
 * passed `aria-describedby` is kept alongside the description. `disabled` becomes `aria-disabled`
 * with the click swallowed, so a disabled action still shows its tooltip. Needs an
 * `IconActionProvider` above it.
 */
export function IconAction({
  command: id,
  label,
  badge,
  count,
  description,
  shortcut,
  href,
  download,
  as,
  size = "md",
  variant = "ghost",
  side = "bottom",
  className,
  children,
  disabled,
  onClick,
  ...rest
}: IconActionProps) {
  const cmd = command(id);
  const Icon = cmd.icon;
  const descriptionId = useId();
  const named = label ?? cmd.name;
  const name = badge ? `${named}, ${badge}` : named;
  const keys: readonly string[] =
    shortcut === undefined
      ? SHORTCUTS_BOUND
        ? shortcutsOf(cmd)
        : []
      : shortcut === null
        ? []
        : [shortcut];
  const target = href ?? cmd.href;
  const inert = isInert(disabled, rest["aria-disabled"]);
  const describedBy = [rest["aria-describedby"], description ? descriptionId : undefined]
    .filter(Boolean)
    .join(" ");

  const props = {
    ...rest,
    "aria-label": name,
    "data-command": id,
    ...(keys.length > 0 ? { "aria-keyshortcuts": keys.map(ariaKeyShortcuts).join(" ") } : {}),
    ...(describedBy ? { "aria-describedby": describedBy } : {}),
    ...(inert ? { "aria-disabled": true } : {}),
    onClick: (e: MouseEvent<HTMLElement>) => {
      if (inert) {
        e.preventDefault();
        return;
      }
      onClick?.(e as MouseEvent<HTMLButtonElement>);
    },
  };
  const face = (
    <>
      {children ?? <Icon aria-hidden />}
      {badge && <Badge count={count} />}
    </>
  );
  const linkProps = props as unknown as ComponentProps<"a">;
  // Links and summaries take the button's look through `asChild`; actions are buttons.
  const element =
    target !== undefined ? (
      download ? (
        <a {...linkProps} href={target} download>
          {face}
        </a>
      ) : (
        <Link {...(props as unknown as Omit<ComponentProps<typeof Link>, "href">)} href={target}>
          {face}
        </Link>
      )
    ) : as === "summary" ? (
      <summary {...(props as unknown as ComponentProps<"summary">)}>{face}</summary>
    ) : (
      <button type="button" {...props}>
        {face}
      </button>
    );

  return (
    <>
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            asChild
            variant={variant}
            size="icon"
            className={cn(styles.action, SIZES[size], INERT, className)}
          >
            {element}
          </Button>
        </TooltipTrigger>
        <TooltipContent side={side}>
          {name}
          {keys.map((k) => (
            <kbd key={k} className={styles.keys}>
              {formatShortcut(k, isMacPlatform())}
            </kbd>
          ))}
          {description && <span className={styles.description}>{description}</span>}
        </TooltipContent>
      </Tooltip>
      {description && (
        <span id={descriptionId} className="sr-only">
          {description}
        </span>
      )}
    </>
  );
}
