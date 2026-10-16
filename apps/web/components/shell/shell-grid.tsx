import type { CSSProperties, ReactNode } from "react";
import { ARTIFACT_WIDTH_VAR } from "../../lib/chat/artifact-tabs";
import styles from "./shell.module.css";

/**
 * The workspace grid under the bar (CE5–CE7, KOBE-197): rail, artifact column, conversation. The
 * artifact column takes no space while empty, so the conversation fills what the rail leaves.
 *
 * Slots for the Phase A tickets that plug in here:
 * - rail: the workspace rail (A2, KOBE-198), 280 px or 48 px collapsed;
 * - artifact: the artifact tabs (A4, KOBE-200), drag-resizable against the conversation;
 *   `artifactWidth` is the dragged width in px (null: half the space right of the rail);
 * - breakpoints (CE7, CE8, KOBE-201, `lib/shell/layout.ts`): under 820 px the artifact column is a
 *   sheet, shown while `artifactSheet` (the member opened an artifact); under 768 px one column.
 */
export function ShellGrid({
  rail,
  artifact,
  conversation,
  artifactWidth = null,
  artifactSheet = false,
  artifactHidden = false,
}: {
  readonly rail: ReactNode;
  readonly artifact: ReactNode;
  readonly conversation: ReactNode;
  readonly artifactWidth?: number | null;
  readonly artifactSheet?: boolean;
  /** The member hid the column (CE23, KOBE-225): no space, its tabs and previews stay mounted. */
  readonly artifactHidden?: boolean;
}) {
  const style =
    artifactWidth === null
      ? undefined
      : ({ [ARTIFACT_WIDTH_VAR]: `${artifactWidth}px` } as CSSProperties);
  return (
    <div className={styles.grid} style={style}>
      <div className={styles.rail} data-shell-region="rail">
        {rail}
      </div>
      <div
        id="kobe-artifact-column"
        className={styles.artifact}
        data-shell-region="artifact"
        {...(artifactSheet ? { "data-sheet-open": "" } : {})}
        {...(artifactHidden ? { "data-hidden": "" } : {})}
      >
        {artifact}
      </div>
      <div className={styles.conversation} data-shell-region="conversation">
        {conversation}
      </div>
    </div>
  );
}
