"use client";

import { MoonIcon, SunIcon } from "lucide-react";
import { IconAction } from "./icon-action";
import styles from "./shell.module.css";
import { toggleTheme, useTheme } from "./use-theme";

/**
 * The bar's light/dark switch (KOBE-282): a toggle button named "Dark theme", pressed while the
 * theme is dark; the icon shows the current theme. Both icons are rendered and app/theme.css shows
 * the matching one, so the first paint is right even when the theme follows the OS, which the
 * server cannot know (`aria-pressed` waits for the client).
 */
export function ThemeToggle() {
  const theme = useTheme();
  return (
    <IconAction
      command="theme"
      className={styles.iconLink}
      {...(theme === null ? {} : { "aria-pressed": theme === "dark" })}
      onClick={toggleTheme}
    >
      <SunIcon aria-hidden data-theme-icon="light" className={styles.whenLight} />
      <MoonIcon aria-hidden data-theme-icon="dark" className={styles.whenDark} />
    </IconAction>
  );
}
