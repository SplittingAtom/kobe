"use client";

import { useState } from "react";
import { authClient } from "../../lib/auth-client";
import { forgetLastThread } from "../../lib/shell/last-thread";
import { barMenuProps } from "./bar-menu";
import { IconAction } from "./icon-action";
import { MenuLink } from "./text-links";
import styles from "./shell.module.css";

/**
 * The profile menu at the bar's right end (CE3): the member's other areas and sign-out. A
 * disclosure, like the team switcher; one of the two is open at a time. Slot: a member settings page joins this menu when one exists.
 */
export function ProfileMenu() {
  const [error, setError] = useState<string | null>(null);

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
          <MenuLink href="/me/skills">My skills</MenuLink>
        </li>
        <li>
          <MenuLink href="/me/projects">Projects</MenuLink>
        </li>
        <li>
          <MenuLink href="/me/connectors">My connectors</MenuLink>
        </li>
        <li>
          <MenuLink href="/me/approvals">My approvals</MenuLink>
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
