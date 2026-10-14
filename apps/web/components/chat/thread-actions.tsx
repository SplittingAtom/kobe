"use client";

import { barMenuProps } from "../shell/bar-menu";
import { IconAction } from "../shell/icon-action";
import styles from "../shell/shell.module.css";

/**
 * The open thread's actions menu in bar row two (CE15; on one column it sits in the bar's Menu with
 * the rest of row two, CE8): Compact now, enabled only while the thread is idle. A disclosure like
 * the profile menu; later thread actions (pin, archive, move, share) join it.
 */
export function ThreadActionsMenu({
  blocker,
  onCompact,
}: {
  /** Why Compact now is unavailable (`compactBlocker`), or null. */
  readonly blocker: string | null;
  readonly onCompact: () => void;
}) {
  return (
    <details className={styles.menu} {...barMenuProps} data-thread-actions>
      <IconAction command="thread-actions" as="summary" className={styles.iconLink} />
      <ul className={styles.menuList}>
        <li>
          <button
            type="button"
            aria-disabled={blocker !== null}
            title={blocker ?? undefined}
            onClick={(e) => {
              if (blocker !== null) return;
              e.currentTarget.closest("details")?.removeAttribute("open");
              onCompact();
            }}
          >
            Compact now…
          </button>
          {blocker !== null && <span className="sr-only">{blocker}</span>}
        </li>
      </ul>
    </details>
  );
}
