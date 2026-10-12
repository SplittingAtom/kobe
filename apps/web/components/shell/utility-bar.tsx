"use client";

import { TeamSwitcher } from "../../app/team-switcher";
import { NotificationBell } from "../chat/notification-bell";
import { AreaLinks, ConsoleIconLinks } from "./bar-links";
import { ProfileMenu } from "./profile-menu";
import { ShellSlotTarget } from "./shell-slots";
import styles from "./shell.module.css";

/**
 * The two-row utility bar (CE3, KOBE-197), about 96 px. Row one (56 px): team switcher, wordmark,
 * thread search, then the member's areas, the consoles (role-gated), notifications and the profile
 * menu. Row two (40 px): the open thread's context, filled by the workspace through its slot.
 */
export function UtilityBar({
  teamId,
  fetchFn,
  onOpenThread,
}: {
  readonly teamId: string | null;
  readonly fetchFn?: typeof fetch | undefined;
  readonly onOpenThread: (threadId: string) => void;
}) {
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
