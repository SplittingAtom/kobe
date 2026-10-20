"use client";

import { useEffect, useId, useRef, type ReactNode } from "react";
import type { Panel } from "../../lib/shell/panels";
import { ensureConsolePortal } from "../ui/chat-portal";
import { PanelContent, type PanelCloseGuard } from "../ui/console/panel-content";
import { IconAction } from "./icon-action";
import { useModalLayer } from "./use-modal-layer";
import styles from "./workspace-panel.module.css";

/**
 * A panel over the workspace (KOBE-452): the consoles, My agents, Skills and the My area open
 * here, a large centred overlay (about 90% of the window, the workspace dimmed and inert behind
 * it); under 820 px a full-screen sheet. The rail, the artifact column and the conversation stay
 * mounted underneath, so a run keeps streaming and the draft and scroll stay as they were.
 *
 * A modal dialog named by its heading: focus moves in when it opens and stays in (the rest of the
 * chat is inert), and returns to the control that opened it when it closes. Close, Escape and a
 * press outside close it; with unsaved edits they ask first (`PanelContent`). The page inside is the
 * route's own (`children`), rendered by the console and My area shells in panel mode.
 */
export function WorkspacePanel({
  panel,
  path,
  onClose,
  children,
}: {
  readonly panel: Panel;
  /** The panel's address: a step inside it starts the unsaved-edit tracking over. */
  readonly path: string;
  readonly onClose: () => void;
  readonly children: ReactNode;
}) {
  const ref = useRef<HTMLElement>(null);
  const titleId = useId();
  const guard = useRef<PanelCloseGuard | null>(null);
  const asking = useRef(false);
  const requestClose = () => {
    if (asking.current) return;
    const ask = guard.current;
    if (ask === null) {
      onClose();
      return;
    }
    asking.current = true;
    void ask().then((close) => {
      asking.current = false;
      if (close) onClose();
    });
  };
  // The console's dialogs and menus mount at the document's top, over this panel.
  useEffect(() => void ensureConsolePortal(), []);
  useModalLayer(ref, true, requestClose, { modal: true, escape: true });
  // Opened by a link or a reload, nothing had focus: it goes to the conversation once closed.
  useEffect(
    () => () => {
      requestAnimationFrame(() => {
        const at = document.activeElement;
        if (at === null || at === document.body) document.getElementById("kobe-chat-main")?.focus();
      });
    },
    [],
  );
  return (
    <>
      <div className={styles.backdrop} aria-hidden="true" data-kobe-panel-backdrop="" />
      <section
        ref={ref}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        data-kobe-panel={panel.id}
        className={styles.panel}
      >
        <div className={styles.header}>
          <h2 id={titleId} className={styles.title}>
            {panel.title}
          </h2>
          <IconAction command="area-close" label={`Close ${panel.title}`} onClick={requestClose} />
        </div>
        <div className={styles.body}>
          <PanelContent title={panel.title} path={path} embedded={panel.embedded} guard={guard}>
            {children}
          </PanelContent>
        </div>
      </section>
    </>
  );
}
