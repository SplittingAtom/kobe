"use client";

import { useMemo, type ReactNode } from "react";
import { headOf, isBrowsing } from "../../lib/chat/head";
import { junctionCount, projectTree } from "../../lib/chat/tree-nodes";
import { FILES_LEFT_NOTE, filesLeftBehind } from "../../lib/chat/tree-panel";
import { BranchBar } from "./branch-bar";
import type { KobeThreadExtras } from "./kobe-runtime";
import { useTreeData } from "./tree-context";
import styles from "./chat.module.css";

const BUTTON =
  "text-muted-foreground hover:bg-muted focus-visible:ring-ring inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-xs focus-visible:ring-2 focus-visible:outline-none";

/**
 * The header's "⑂ Tree" (CT12): opens the Conversation tree; its badge is the junction count, or
 * the fork count when there are no junctions. Not on a draft (no thread yet).
 */
export function TreeButton({ extras }: { readonly extras: KobeThreadExtras }) {
  const data = useTreeData();
  const { entries } = extras.state;
  const junctions = useMemo(() => junctionCount(entries), [entries]);
  if (data?.open == null || extras.state.threadId === null) return null;
  const forks = data.lineage?.forks.length ?? 0;
  const badge = junctions > 0 ? junctions : forks;
  const what =
    junctions > 0
      ? `${junctions} ${junctions === 1 ? "branch" : "branches"}`
      : `${forks} ${forks === 1 ? "fork" : "forks"}`;
  const open = data.open;
  return (
    <button
      type="button"
      className={BUTTON}
      aria-label={badge > 0 ? `Conversation tree, ${what}` : "Conversation tree"}
      data-kobe-tree-button=""
      onClick={open}
    >
      <span aria-hidden>⑂</span> Tree
      {badge > 0 && (
        <span aria-hidden className="bg-muted rounded-full px-1.5 tabular-nums">
          {badge}
        </span>
      )}
    </button>
  );
}

/** "Forked here · N branches" as the way to the tree (CT12); plain text outside a host. */
export function TreeLink({ children }: { readonly children: ReactNode }) {
  const open = useTreeData()?.open;
  if (!open) return <span>{children}</span>;
  return (
    <button
      type="button"
      className="hover:text-foreground underline-offset-2 hover:underline"
      onClick={open}
      data-kobe-tree-link=""
    >
      {children}
    </button>
  );
}

/** CT3's bar with the way to the tree, and CT6's files line when the leaf's branch changed files. */
export function TreeBranchBar({ extras }: { readonly extras: KobeThreadExtras }) {
  const data = useTreeData();
  const { state } = extras;
  const browsing = isBrowsing(state);
  const head = headOf(state);
  const leaf = state.summary?.leafEntryId ?? null;
  const filesLeft = useMemo(() => {
    if (!browsing) return false;
    const tree = projectTree(state.entries, head, leaf);
    return filesLeftBehind(tree, tree.headId);
  }, [browsing, state.entries, head, leaf]);
  const owner = state.summary?.readOnly !== true;
  return (
    <BranchBar
      extras={extras}
      filesChanged={
        filesLeft && owner ? <p className={styles.hint}>{FILES_LEFT_NOTE}</p> : undefined
      }
      tree={
        data?.open ? (
          <button type="button" className={styles.branchBarAction} onClick={data.open}>
            Tree
          </button>
        ) : undefined
      }
    />
  );
}
