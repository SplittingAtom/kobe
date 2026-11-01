"use client";

import { Popover } from "radix-ui";
import { TeamList, teamInitials, type MyTeamsState } from "../../app/team-switcher";
import { roleLabel } from "../../lib/teams";
import { chatPortalContainer } from "../ui/chat-portal";
import { Tooltip, TooltipContent, TooltipTrigger } from "../ui/tooltip";
import styles from "./rail.module.css";

/**
 * The rail's team selector (KOBE-419; the bar's top-left switcher before): the active team's name,
 * a menu of the member's teams with their roles when they are in more than one (switching sets the
 * active team and reloads), its plain name otherwise. The name truncates, with all of it as the
 * tooltip, so the line's buttons never wrap or clip. The slot clips (KOBE-419 review S1), so the
 * list opens in a popover in the chat portal, like the collapsed rail's (KOBE-538); Escape closes
 * it and returns focus to the name.
 */
export function RailTeam({
  teams,
  teamName,
}: {
  readonly teams: MyTeamsState;
  /** The active team's name from the chat's own read: shown until the teams are listed. */
  readonly teamName: string;
}) {
  const { my, switchTo } = teams;
  if (my !== null && my.teams.length > 1) {
    const active = my.teams.find((t) => t.id === my.activeTeamId);
    return (
      <div className={styles.teamSlot}>
        <nav aria-label="Teams" className={styles.teamMenu}>
          <Popover.Root>
            <Popover.Trigger className={styles.teamSummary} title={active?.name}>
              <span className={styles.team}>{active ? active.name : "Choose a team"}</span>
              {active && <small> · {roleLabel(active.role)}</small>}
            </Popover.Trigger>
            <Popover.Portal container={chatPortalContainer()}>
              <Popover.Content
                side="bottom"
                align="start"
                sideOffset={4}
                className={styles.teamPopover}
              >
                <TeamList my={my} switchTo={switchTo} label="Your teams" />
              </Popover.Content>
            </Popover.Portal>
          </Popover.Root>
        </nav>
      </div>
    );
  }
  return (
    <div className={styles.teamSlot}>
      <h2 className={styles.team} title={teamName}>
        {teamName}
      </h2>
    </div>
  );
}

/**
 * The collapsed rail's team (KOBE-419 review S2): the team's initials at the top of the icon
 * strip, its name and role as the tooltip and accessible name. With several teams it opens the
 * same list as the selector, in a popover beside the 48 px rail; with one, the tooltip only.
 */
export function RailTeamIcon({
  teams,
  teamName,
}: {
  readonly teams: MyTeamsState;
  readonly teamName: string;
}) {
  const { my, switchTo } = teams;
  const active = my?.teams.find((t) => t.id === my.activeTeamId);
  const name = active?.name ?? teamName;
  if (name === "") return null;
  const label = active ? `Team: ${name}, ${roleLabel(active.role)}` : `Team: ${name}`;
  const face = teamInitials(name);
  if (my === null || my.teams.length < 2) {
    return (
      <Tooltip>
        <TooltipTrigger asChild>
          <span role="img" aria-label={label} tabIndex={0} className={styles.teamIcon}>
            {face}
          </span>
        </TooltipTrigger>
        <TooltipContent side="right">{label}</TooltipContent>
      </Tooltip>
    );
  }
  return (
    <Popover.Root>
      <Tooltip>
        <TooltipTrigger asChild>
          <Popover.Trigger aria-label={label} className={styles.teamIcon}>
            {face}
          </Popover.Trigger>
        </TooltipTrigger>
        <TooltipContent side="right">{label}</TooltipContent>
      </Tooltip>
      <Popover.Portal container={chatPortalContainer()}>
        <Popover.Content side="right" align="start" sideOffset={6} className={styles.teamPopover}>
          <TeamList my={my} switchTo={switchTo} label="Your teams" />
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}
