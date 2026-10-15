"use client";

import "../../app/chat-global.css";
import { IconActionProvider } from "../shell/icon-action";
import { ThemeToggle } from "../shell/theme-toggle";
import styles from "./admin.module.css";

/**
 * The chat bar's theme toggle (KOBE-282) in a console or My-area header. Its tooltip and button
 * use the chat's Tailwind utilities, so this loads the chat stylesheet (as the agent builder's test
 * pane does); its tooltip provider is its own, the consoles have no other IconActions.
 */
export function ConsoleThemeToggle() {
  return (
    <IconActionProvider>
      <ThemeToggle className={styles.themeToggle} />
    </IconActionProvider>
  );
}
