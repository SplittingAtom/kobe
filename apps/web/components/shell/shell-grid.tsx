import type { ReactNode } from "react";
import styles from "./shell.module.css";

/**
 * The workspace grid under the bar (CE5–CE7, KOBE-197): rail, artifact column, conversation. The
 * artifact column takes no space while empty, so the conversation fills what the rail leaves.
 *
 * Slots for the Phase A tickets that plug in here:
 * - rail: A2 (KOBE-198) replaces the thread sidebar with Threads over Files, 280/48 px;
 * - artifact: A4 (KOBE-200) puts the artifact tabs here, drag-resizable against the conversation;
 * - breakpoints: A5 (KOBE-201) owns the CE7 yield order and the overlay sheet (shell.module.css).
 */
export function ShellGrid({
  rail,
  artifact,
  conversation,
}: {
  readonly rail: ReactNode;
  readonly artifact: ReactNode;
  readonly conversation: ReactNode;
}) {
  return (
    <div className={styles.grid}>
      <div className={styles.rail} data-shell-region="rail">
        {rail}
      </div>
      <div className={styles.artifact} data-shell-region="artifact">
        {artifact}
      </div>
      <div className={styles.conversation} data-shell-region="conversation">
        {conversation}
      </div>
    </div>
  );
}
