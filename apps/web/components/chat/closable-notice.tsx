"use client";

import { useEffect, useState, type AriaRole, type MouseEvent, type ReactNode } from "react";
import { closeNotice, isNoticeClosed } from "../../lib/chat/closed-notices";
import { cn } from "../../lib/utils";
import { IconAction } from "../shell/icon-action";
import styles from "./chat.module.css";

/**
 * Whether the notice `id` is closed for this viewer, and how to close it (KOBE-468). Storage is
 * read after mount, so the server and the first client render agree (both show the notice).
 */
export function useClosedNotice(id: string | undefined): readonly [boolean, () => void] {
  const [closed, setClosed] = useState(false);
  useEffect(() => {
    setClosed(id !== undefined && isNoticeClosed(id));
  }, [id]);
  const close = () => {
    if (id === undefined) return;
    closeNotice(id);
    setClosed(true);
  };
  return [closed, close];
}

/** The member goes on in the composer once the notice (and its focused ×) is gone. */
function focusComposer(root: ParentNode): void {
  root.querySelector<HTMLTextAreaElement>("[data-kobe-composer] textarea")?.focus();
}

/** The close (×) button of a notice; closing moves focus to the thread's composer. */
export function CloseNoticeButton({
  label,
  onClose,
}: {
  readonly label: string;
  readonly onClose: () => void;
}) {
  return (
    <IconAction
      command="dismiss-notice"
      label={label}
      size="sm"
      shortcut={null}
      className="shrink-0"
      onClick={(event: MouseEvent<HTMLButtonElement>) => {
        // Found before closing: the button is detached once the notice is gone.
        const root = event.currentTarget.closest("[data-kobe-thread-root]") ?? document;
        onClose();
        focusComposer(root);
      }}
    />
  );
}

/**
 * A chat notice this viewer can close (KOBE-468): hidden once closed, and remembered per event in
 * this browser. `id` identifies the event (run id and seq), so a later notice still shows.
 */
export function ClosableNotice({
  id,
  label = "Close notice",
  className,
  role,
  children,
}: {
  readonly id: string;
  readonly label?: string;
  readonly className?: string | undefined;
  readonly role?: AriaRole | undefined;
  readonly children: ReactNode;
}) {
  const [closed, close] = useClosedNotice(id);
  if (closed) return null;
  return (
    <div className={cn(styles.closable, className)} role={role}>
      <div className={styles.closableBody}>{children}</div>
      <CloseNoticeButton label={label} onClose={close} />
    </div>
  );
}
