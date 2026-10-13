"use client";

import { NotificationBell } from "../chat/notification-bell";
import { barMenuProps } from "./bar-menu";
import { AreaLinks, ConsoleIconLinks } from "./bar-links";
import { IconAction } from "./icon-action";
import { ProfileMenu } from "./profile-menu";
import { ShellSlotTarget } from "./shell-slots";
import styles from "./shell.module.css";

/**
 * The one-row bar's menu (CE8, KOBE-201), under 768 px: everything the two-row bar shows beside
 * the team switcher and the title. Row two's controls (agent and model pickers, Files) land here
 * through the same slot, then the search, the member's areas, the consoles, notifications and the
 * profile menu. A disclosure like the other bar menus: Escape or a press outside closes it.
 */
export function BarOverflowMenu({
  teamId,
  fetchFn,
  onOpenThread,
}: {
  readonly teamId: string | null;
  readonly fetchFn?: typeof fetch | undefined;
  readonly onOpenThread: (threadId: string) => void;
}) {
  return (
    <details className={styles.menu} data-bar-overflow {...barMenuProps}>
      <IconAction command="thread-menu" as="summary" className={styles.iconLink} />
      <div className={styles.overflowPanel}>
        <ShellSlotTarget
          name="context"
          role="group"
          aria-label="Conversation context"
          className={styles.overflowContext}
        />
        {/* Slot: the context gauge (CE14, B7 KOBE-211) renders in row two's slot above, so on
            one column it lands in this menu with the pickers; nothing to build until B7. */}
        <ShellSlotTarget name="search" className={styles.search} />
        <div className={styles.overflowActions}>
          <AreaLinks />
          <ConsoleIconLinks />
          {teamId !== null && (
            <NotificationBell teamId={teamId} fetchFn={fetchFn} onOpenThread={onOpenThread} />
          )}
          <ProfileMenu />
        </div>
      </div>
    </details>
  );
}
