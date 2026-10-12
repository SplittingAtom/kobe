"use client";

import Link from "next/link";
import { useId, type ComponentProps, type ReactNode } from "react";
import {
  ariaKeyShortcuts,
  command,
  formatShortcut,
  SHORTCUTS_BOUND,
  type CommandId,
} from "../../lib/shell/commands";
import { cn } from "../../lib/utils";
import { Button } from "../ui/button";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "../ui/tooltip";
import styles from "./icon-action.module.css";

/** CE13: the tooltip opens after 300 ms. */
export const TOOLTIP_DELAY_MS = 300;

const SIZES = { sm: "size-6 p-1 active:scale-90", md: "size-8" } as const;

interface OwnProps {
  /** The registry entry: icon, name, shortcut and (for navigation) href. */
  readonly command: CommandId;
  /** Replaces the command's name when the object matters ("Rename Budget"). */
  readonly label?: string | undefined;
  /** What is new behind this icon ("2 unread"): shows the dot and joins the accessible label. */
  readonly badge?: string | undefined;
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
  readonly side?: "top" | "bottom" | "left" | "right" | undefined;
  /** Replaces the command's icon (the copy action's check mark). */
  readonly children?: ReactNode;
}

export type IconActionProps = OwnProps &
  Omit<ComponentProps<"button">, keyof OwnProps | "aria-label">;

function onMac(): boolean {
  return typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform);
}

/**
 * One navigation or action icon (CE13, KOBE-203): a lucide icon with a radix tooltip that names the
 * action and shows its shortcut. The name is also the accessible label; a dot badge marks a panel
 * with something new. Content (thread titles, names, markers, tables) stays text, never this.
 * Button props pass through, so assistant-ui primitives can render it with `asChild`.
 */
export function IconAction({
  command: id,
  label,
  badge,
  description,
  shortcut,
  href,
  download,
  as,
  size = "md",
  side = "bottom",
  className,
  children,
  ...rest
}: IconActionProps) {
  const cmd = command(id);
  const Icon = cmd.icon;
  const descriptionId = useId();
  const named = label ?? cmd.name;
  const name = badge ? `${named}, ${badge}` : named;
  const keys = shortcut === undefined ? (SHORTCUTS_BOUND ? cmd.shortcut : undefined) : shortcut;
  const target = href ?? cmd.href;

  const own = {
    "aria-label": name,
    "data-command": id,
    ...(keys ? { "aria-keyshortcuts": ariaKeyShortcuts(keys) } : {}),
    ...(description ? { "aria-describedby": descriptionId } : {}),
  };
  const face = (
    <>
      {children ?? <Icon aria-hidden />}
      {badge && <span className={styles.dot} data-badge aria-hidden="true" />}
    </>
  );
  // Links and summaries take the button's look through `asChild`; actions are buttons.
  const element =
    target !== undefined ? (
      download ? (
        <a href={target} download {...own}>
          {face}
        </a>
      ) : (
        <Link href={target} {...own}>
          {face}
        </Link>
      )
    ) : as === "summary" ? (
      <summary {...own}>{face}</summary>
    ) : undefined;
  const classes = cn(styles.action, SIZES[size], className);

  return (
    <TooltipProvider delayDuration={TOOLTIP_DELAY_MS}>
      <Tooltip>
        <TooltipTrigger asChild>
          {element === undefined ? (
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className={classes}
              {...own}
              {...rest}
            >
              {face}
            </Button>
          ) : (
            <Button asChild variant="ghost" size="icon" className={classes} {...rest}>
              {element}
            </Button>
          )}
        </TooltipTrigger>
        <TooltipContent side={side}>
          {name}
          {keys && <kbd className={styles.keys}>{formatShortcut(keys, onMac())}</kbd>}
          {description && <span className={styles.description}>{description}</span>}
        </TooltipContent>
      </Tooltip>
      {description && (
        <span id={descriptionId} className="sr-only">
          {description}
        </span>
      )}
    </TooltipProvider>
  );
}
