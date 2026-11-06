"use client";

import { useMemo, useState, type ReactNode } from "react";
import { branchContextTokens, headOf, isBrowsing, messagesDiffer } from "../../lib/chat/head";
import { IconAction } from "../shell/icon-action";
import { threadScale } from "../shell/context-gauge";
import type { KobeThreadExtras } from "./kobe-runtime";
import { useThreadTeamModels } from "./use-team-models";
import styles from "./chat.module.css";

/** The note when the server refuses the leaf move under a run (CT3, Q7): never retried. */
export const LEAF_BUSY_NOTE =
  "The thread is busy: wait for the queued runs, then make this branch current.";
/** CT16 (Q26): shown before Make it current on a branch over the model's window; it proceeds. */
export const OVER_WINDOW_NOTE =
  "This branch is longer than the model's window; compact after switching";
/** CT16: a scheduled thread's next run continues on the leaf. */
export const SCHEDULE_NOTE = "The schedule will continue on this branch.";

/** This thread view's root (found before the bar goes, so a detached button still knows it). */
function threadRootOf(from: Element): Element | null {
  return from.closest("[data-kobe-thread-root]");
}

/** Focus moves to this thread view's composer once the bar is gone (never another view's). */
function focusComposer(root: Element | null): void {
  root?.querySelector<HTMLTextAreaElement>("[data-kobe-composer] textarea")?.focus();
}

/**
 * The bar under the lineage strip while this tab shows another branch than the leaf's (CT3):
 * "⑂ Showing another branch · N messages differ", Make it current (owner) and ✕ (back to the
 * leaf). `filesChanged`: CT6's files-changed line (KOBE-545/546), shown in the bar when given.
 */
export function BranchBar({
  extras,
  filesChanged,
}: {
  readonly extras: KobeThreadExtras;
  readonly filesChanged?: ReactNode;
}) {
  const { state } = extras;
  if (!isBrowsing(state)) return null;
  // Keyed by the head: a note from one branch never shows on the next.
  return <BranchBarBody key={headOf(state)} extras={extras} filesChanged={filesChanged} />;
}

function BranchBarBody({
  extras,
  filesChanged,
}: {
  readonly extras: KobeThreadExtras;
  readonly filesChanged?: ReactNode;
}) {
  const { state, controller, projection } = extras;
  const [note, setNote] = useState<string | undefined>(undefined);
  const loaded = useThreadTeamModels();
  const head = headOf(state);
  const leaf = state.summary?.leafEntryId ?? null;
  const owner = state.summary?.readOnly !== true && controller !== null;
  // O(entries) walks: only again when the tree, the head or the leaf changed (not per event).
  const { entries } = state;
  const { nodeOfEntry } = projection;
  const differ = useMemo(
    () => messagesDiffer(entries, nodeOfEntry, head, leaf),
    [entries, nodeOfEntry, head, leaf],
  );
  const tokens = useMemo(() => branchContextTokens(entries, head), [entries, head]);
  const { agentModel } = state;
  const model = state.summary?.model;
  const window =
    useMemo(() => threadScale(loaded, { agentModel, model }).scale, [loaded, agentModel, model])
      ?.contextWindow ?? null;
  const overWindow = owner && window !== null && typeof tokens === "number" && tokens > window;
  const scheduled = owner && state.summary?.scheduleId != null;
  const moving = state.busy.includes("leaf");

  const makeCurrent = async (button: HTMLButtonElement) => {
    const root = threadRootOf(button);
    setNote(undefined);
    const res = await controller?.makeCurrent();
    if (res && !res.ok && res.error.code === "thread_busy") setNote(LEAF_BUSY_NOTE);
    else if (res?.ok) focusComposer(root);
  };

  return (
    <section aria-label="Another branch" data-kobe-branch-bar="" className={styles.branchBar}>
      <p className={styles.branchBarLine}>
        <span aria-hidden>⑂ </span>
        Showing another branch
        <span aria-hidden> · </span>
        <span className="sr-only">, </span>
        {differ === 1 ? "1 message differs" : `${differ} messages differ`}
      </p>
      {owner && (
        <button
          type="button"
          className={styles.branchBarAction}
          aria-disabled={moving || undefined}
          onClick={(e) => {
            if (!moving) void makeCurrent(e.currentTarget);
          }}
        >
          Make it current
        </button>
      )}
      <IconAction
        command="dismiss-notice"
        label="Back to the current branch"
        size="sm"
        shortcut={null}
        className="shrink-0"
        onClick={(e) => {
          const root = threadRootOf(e.currentTarget);
          controller?.showLeaf();
          focusComposer(root);
        }}
      />
      {(overWindow || scheduled || note !== undefined || filesChanged != null) && (
        <div className={styles.branchBarNotes}>
          {filesChanged}
          {overWindow && <p className={styles.hint}>{OVER_WINDOW_NOTE}</p>}
          {scheduled && <p className={styles.hint}>{SCHEDULE_NOTE}</p>}
          {note !== undefined && (
            <p className={styles.hint} role="status" data-kobe-branch-note="">
              {note}
            </p>
          )}
        </div>
      )}
    </section>
  );
}
