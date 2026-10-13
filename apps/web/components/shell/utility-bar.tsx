"use client";

import { TeamSwitcher } from "../../app/team-switcher";
import { NotificationBell } from "../chat/notification-bell";
import { AreaLinks, ConsoleIconLinks } from "./bar-links";
import { BarOverflowMenu } from "./bar-overflow-menu";
import { ProfileMenu } from "./profile-menu";
import { useShellBand } from "./shell-band";
import { ShellSlotTarget } from "./shell-slots";
import styles from "./shell.module.css";

interface BarProps {
  readonly teamId: string | null;
  readonly fetchFn?: typeof fetch | undefined;
  readonly onOpenThread: (threadId: string) => void;
}

/**
 * Under 768 px (CE8, KOBE-201): one 56 px row with the rail's drawer button (filled by the
 * workspace), the team switcher, the title and the menu that holds everything else.
 */
function OneRowBar(props: BarProps) {
  return (
    <header className={styles.bar} data-bar-layout="single">
      <div className={styles.rowOne} data-bar-row="1">
        <ShellSlotTarget name="nav" className={styles.nav} />
        <TeamSwitcher />
        <h1 className={styles.wordmark}>Kobe</h1>
        <div className={styles.actions}>
          <BarOverflowMenu {...props} />
        </div>
      </div>
    </header>
  );
}

/**
 * The two-row utility bar (CE3, KOBE-197), about 96 px. Row one (56 px): team switcher, wordmark,
 * thread search, then the member's areas, the consoles (role-gated), notifications and the profile
 * menu. Row two (40 px): the open thread's context, filled by the workspace through its slot.
 * Under 768 px it is one row whose menu holds the rest (`OneRowBar`).
 */
export function UtilityBar(props: BarProps) {
  const single = useShellBand() === "single";
  if (single) return <OneRowBar {...props} />;
  const { teamId, fetchFn, onOpenThread } = props;
  return (
    <header className={styles.bar}>
      <div className={styles.rowOne} data-bar-row="1">
        <TeamSwitcher />
        <h1 className={styles.wordmark}>Kobe</h1>
        <ShellSlotTarget name="search" className={styles.search} />
        <div className={styles.actions}>
          <AreaLinks />
          <ConsoleIconLinks />
          {teamId !== null && (
            <NotificationBell teamId={teamId} fetchFn={fetchFn} onOpenThread={onOpenThread} />
          )}
          <ProfileMenu />
        </div>
      </div>
      <ShellSlotTarget
        name="context"
        role="group"
        aria-label="Conversation context"
        className={styles.rowTwo}
        data-bar-row="2"
      />
    </header>
  );
}
