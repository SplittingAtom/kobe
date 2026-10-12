"use client";

import {
  BotIcon,
  BrainIcon,
  CalendarClockIcon,
  ServerCogIcon,
  UsersIcon,
  type LucideIcon,
} from "lucide-react";
import Link from "next/link";
import { consoleHref } from "../../lib/admin/nav/paths";
import { useOpenConsoles } from "../admin/console-links";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "../ui/tooltip";
import styles from "./shell.module.css";

/** CE13: a 300 ms tooltip names the icon; the same name is the link's accessible label. */
const TOOLTIP_DELAY_MS = 300;

// Slot (A7, KOBE-203): these become `IconAction`s fed by the command registry, which adds the
// shortcuts to the tooltips and the dot badges. Until then: an icon link with a tooltip.
function BarLink({
  href,
  label,
  icon: Icon,
}: {
  readonly href: string;
  readonly label: string;
  readonly icon: LucideIcon;
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Link href={href} aria-label={label} className={styles.iconLink}>
          <Icon aria-hidden size={18} />
        </Link>
      </TooltipTrigger>
      <TooltipContent side="bottom">{label}</TooltipContent>
    </Tooltip>
  );
}

/** Bar row one, right side: the member's own areas (full pages for now; CE4 moves some beside). */
export function AreaLinks() {
  return (
    <TooltipProvider delayDuration={TOOLTIP_DELAY_MS}>
      <nav aria-label="My area" className={styles.links}>
        <BarLink href="/me/memory" label="My memory" icon={BrainIcon} />
        <BarLink href="/me/schedules" label="My schedules" icon={CalendarClockIcon} />
        <BarLink href="/me/agents" label="My agents" icon={BotIcon} />
      </nav>
    </TooltipProvider>
  );
}

/** The consoles, role-gated by the server's answer (CE3); full-page routes (CE4). */
export function ConsoleIconLinks() {
  const open = useOpenConsoles();
  if (open.length === 0) return null;
  return (
    <TooltipProvider delayDuration={TOOLTIP_DELAY_MS}>
      <nav aria-label="Administration" className={styles.links}>
        {open.includes("team") && (
          <BarLink href={consoleHref("team")} label="Team console" icon={UsersIcon} />
        )}
        {open.includes("site") && (
          <BarLink href={consoleHref("site")} label="Site console" icon={ServerCogIcon} />
        )}
      </nav>
    </TooltipProvider>
  );
}
