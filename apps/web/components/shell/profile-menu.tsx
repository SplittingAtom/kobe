"use client";

import { useState, type MouseEvent } from "react";
import { authClient } from "../../lib/auth-client";
import { openBeside, plainClick } from "../../lib/shell/areas";
import { forgetLastThread } from "../../lib/shell/last-thread";
import { barMenuProps } from "./bar-menu";
import { IconAction } from "./icon-action";
import { MenuLink } from "./text-links";
import styles from "./shell.module.css";

/**
 * The profile menu at the bar's right end (CE3): the member's other areas and sign-out. A
 * disclosure, like the team switcher; one of the two is open at a time. On the chat page My
 * approvals and My connectors open beside the thread (CE4, KOBE-424); Projects and My shared cases stay
 * full pages (Skills is a bar command, KOBE-321). Slot: a member settings page joins this menu when
 * one exists.
 */
export function ProfileMenu() {
  const [error, setError] = useState<string | null>(null);
  /** CE4 (KOBE-424): My approvals and My connectors open beside the thread on the chat page. */
  const beside = (e: MouseEvent<HTMLAnchorElement>) => {
    if (!plainClick(e) || !openBeside(e.currentTarget.getAttribute("href") ?? "")) return;
    e.preventDefault();
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
          <MenuLink href="/me/projects">Projects</MenuLink>
        </li>
        <li>
          <MenuLink href="/me/connectors" onClick={beside}>
            My connectors
          </MenuLink>
        </li>
        <li>
          <MenuLink href="/me/approvals" onClick={beside}>
            My approvals
          </MenuLink>
        </li>
        <li>
          <MenuLink href="/me/shared-cases">My shared cases</MenuLink>
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
