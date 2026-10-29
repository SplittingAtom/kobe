"use client";

import { useBranding } from "./branding-context";
import styles from "./brand.module.css";

/**
 * The site's brand (theming plan §4.3, docs/theming.md §2): the bar's wordmark and the console
 * and My area brand links. With no logo it is the name alone, as text, exactly as before
 * branding existed. With a logo: the logo (24 px tall, ≤ 160 px wide; the dark logo, when there
 * is one, in the dark theme through the --kobe-when-* tokens) and the name, which stays the
 * accessible name even when the admin hides it visually ("Show the name next to the logo" off).
 */
export function Brand() {
  const { appName, showName, logo } = useBranding();
  if (logo === null) return appName;
  const light = logo.dark ? `${styles.logo} ${styles.whenLight}` : styles.logo;
  return (
    <span className={styles.brand} data-brand="">
      {/* Same-origin asset URLs (lib/theme/branding-server.ts); the name carries the meaning. */}
      <img src={logo.url} alt="" height={24} decoding="async" className={light} data-logo="light" />
      {logo.dark && (
        <img
          src={logo.dark}
          alt=""
          height={24}
          decoding="async"
          className={`${styles.logo} ${styles.whenDark}`}
          data-logo="dark"
        />
      )}
      <span className={showName ? undefined : styles.hidden}>{appName}</span>
    </span>
  );
}
