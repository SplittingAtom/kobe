"use client";

import { useState, type MouseEvent } from "react";
import { authClient } from "../../lib/auth-client";
import { forgetReloadDrafts } from "../../lib/build/reload-draft";
import { forgetLastThread } from "../../lib/shell/last-thread";
import { barMenuProps } from "./bar-menu";
import { IconAction } from "./icon-action";
import { MenuLink } from "./text-links";
import styles from "./shell.module.css";

/**
 * The profile menu at the bar's right end (CE3): the member's other areas and sign-out. A
 * disclosure, like the team switcher; one of the two is open at a time. Each page opens as a panel
 * over the workspace (KOBE-452; Skills is a bar command, KOBE-321), and the menu closes behind it.
 * Slot: a member settings page joins this menu when one exists.
 */
export function ProfileMenu() {
  const [error, setError] = useState<string | null>(null);
  /** The page opens in a panel (KOBE-452): the menu doesn't stay open behind it. */
  const close = (e: MouseEvent<HTMLAnchorElement>) => {
    const menu = e.currentTarget.closest("details");
    if (menu) menu.open = false;
  };

  async function signOut() {
    setError(null);
    try {
      const res = await authClient.signOut();
      if (res.error) {
        setError(res.error.message ?? "Could not sign out. Try again.");
        return;
      }
      forgetLastThread();
      forgetReloadDrafts();
      window.location.assign("/sign-in");
    } catch {
      setError("Could not sign out. Check your connection and try again.");
    }
  }

  return (
    <details className={styles.menu} {...barMenuProps}>
      <IconAction command="profile" as="summary" className={styles.iconLink} />
      <ul className={styles.menuList}>
        <li>
          <MenuLink href="/me/projects" onClick={close}>
            Projects
          </MenuLink>
        </li>
        <li>
          <MenuLink href="/me/connectors" onClick={close}>
            My connectors
          </MenuLink>
        </li>
        <li>
          <MenuLink href="/me/approvals" onClick={close}>
            My approvals
          </MenuLink>
        </li>
        <li>
          <MenuLink href="/me/shared-cases" onClick={close}>
            My shared cases
          </MenuLink>
        </li>
        <li>
          <button type="button" onClick={() => void signOut()}>
            Sign out
          </button>
        </li>
        {error && (
          <li role="alert" className={styles.menuError}>
            {error}
          </li>
        )}
      </ul>
    </details>
  );
}
