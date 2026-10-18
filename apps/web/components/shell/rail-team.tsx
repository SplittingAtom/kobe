"use client";

import { TeamMenu, type MyTeamsState } from "../../app/team-switcher";
import styles from "./rail.module.css";
import shellStyles from "./shell.module.css";

/**
 * The rail's team selector (KOBE-419; the bar's top-left switcher before): the active team's name,
 * a menu of the member's teams with their roles when they are in more than one (switching sets the
 * active team and reloads), its plain name otherwise. The name truncates, with all of it as the
 * tooltip, so the line's buttons never wrap or clip.
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
    return (
      <div className={styles.teamSlot}>
        <TeamMenu
          my={my}
          switchTo={switchTo}
          classes={{
            nav: `${shellStyles.menu} ${styles.teamMenu}`,
            summary: styles.teamSummary,
            name: styles.team,
            list: `${shellStyles.menuList} ${styles.teamList}`,
          }}
        />
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
