"use client";

import { useCallback, useEffect, useRef, type RefObject } from "react";
import { NotificationBell } from "../chat/notification-bell";
import { CHAT_PORTALLED } from "../ui/chat-portal";
import { AreaLinks, ConsoleIconLinks } from "./bar-links";
import { IconAction } from "./icon-action";
import { ProfileMenu } from "./profile-menu";
import { useShellBand } from "./shell-band";
import { ThemeToggle } from "./theme-toggle";
import { ShellSlotTarget, useBarMenu } from "./shell-slots";
import { useNavigate } from "./use-navigate";
import styles from "./shell.module.css";

const MENU_ID = "kobe-bar-menu";

/**
 * The one-row bar's menu closes on a press outside the bar and on Escape (focus to its button). A
 * press in content portalled out of the bar (Radix popovers, the Compact dialog) stays in the menu.
 */
function useMenuDismiss(header: RefObject<HTMLElement | null>, open: boolean, close: () => void) {
  useEffect(() => {
    if (!open) return;
    const onPointerDown = (e: PointerEvent) => {
      const target = e.target instanceof Element ? e.target : null;
      if (!target || header.current?.contains(target) || target.closest(CHAT_PORTALLED)) return;
      close();
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || e.defaultPrevented) return;
      e.preventDefault();
      close();
      header.current?.querySelector<HTMLElement>('[data-command="thread-menu"]')?.focus();
    };
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [header, open, close]);
}

/**
 * The utility bar (CE3, KOBE-197): one 56 px row of wordmark, thread search, then the member's
 * areas, the Site console (role-gated), notifications, the theme toggle (KOBE-282) and the profile
 * menu. The team selector and Team console moved to the rail's top line (KOBE-419). Its second
 * row went in KOBE-418: the agent, model and thinking selectors are in the composer's toolbar, the
 * context gauge under the composer, Show details and Compact now on the answers, and the rail
 * shows Files.
 *
 * Under 768 px (CE8, KOBE-201) it is the rail's drawer button with the active team's name (filled
 * by the workspace; the drawer is headed by the team selector), the title and a Menu that
 * discloses the rest. One tree at every width, so nothing remounts (search text, notifications)
 * when the window crosses 768 px; only the Menu button comes and goes.
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
  const single = useShellBand() === "single";
  const menu = useBarMenu();
  const { setOpen } = menu;
  const open = single && menu.open;
  useEffect(() => {
    if (!single) setOpen(false);
  }, [single, setOpen]);
  const header = useRef<HTMLElement>(null);
  const close = useCallback(() => setOpen(false), [setOpen]);
  useMenuDismiss(header, open, close);
  const folded = single && !open;
  // A skill from a notification opens in the Skills panel, the workspace kept (KOBE-452).
  const navigate = useNavigate();
  return (
    <header
      ref={header}
      className={styles.bar}
      data-bar-layout={single ? "single" : "wide"}
      {...(open ? { "data-menu-open": "" } : {})}
    >
      <div className={styles.rowOne} data-bar-row="1">
        <ShellSlotTarget name="nav" className={styles.nav} />
        <h1 className={styles.wordmark}>Kobe</h1>
        {single && (
          <IconAction
            command="thread-menu"
            className={styles.iconLink}
            aria-expanded={open}
            aria-controls={MENU_ID}
            onClick={() => setOpen(!open)}
          />
        )}
        <div id={MENU_ID} className={styles.menuPanel} hidden={folded}>
          <ShellSlotTarget name="search" className={styles.search} />
          <div className={styles.actions}>
            <AreaLinks />
            <ConsoleIconLinks />
            {teamId !== null && (
              <NotificationBell
                teamId={teamId}
                fetchFn={fetchFn}
                onOpenThread={onOpenThread}
                onOpenSkill={navigate}
              />
            )}
            <ThemeToggle />
            <ProfileMenu />
          </div>
        </div>
      </div>
    </header>
  );
}
