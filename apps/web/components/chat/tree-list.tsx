"use client";

import { useState } from "react";
import type { TreeProjection } from "../../lib/chat/tree-nodes";
import {
  EMPTY_TREE_NOTE,
  badgeTexts,
  junctionGroups,
  nodeName,
  nodeText,
  nodeTime,
} from "../../lib/chat/tree-panel";
import type { KobeThreadExtras } from "./kobe-runtime";
import { NodeMenu, useTreeActions } from "./tree-actions";
import type { TreeData } from "./tree-context";
import styles from "./conversation-tree.module.css";

const START = "The start of the conversation";

/**
 * The narrow tree (CT18, under 820 px): one section per junction, headed by the message above
 * it; each branch a row with its label, excerpt, time, badges and the on-screen and leaf chips.
 * A row opens that branch (the head); its ⋯ holds the node menu.
 */
export function TreeList({
  extras,
  data,
  tree,
  onClose,
}: {
  readonly extras: KobeThreadExtras;
  readonly data: TreeData;
  readonly tree: TreeProjection;
  readonly onClose: () => void;
}) {
  const actions = useTreeActions(extras, tree, data, onClose);
  const [menuFor, setMenuFor] = useState<string | null>(null);
  const groups = junctionGroups(tree);
  if (groups.length === 0) return <p className={styles.note}>{EMPTY_TREE_NOTE}</p>;
  return (
    <>
      {groups.map((group) => {
        const head = group.parent === null ? START : nodeText(group.parent);
        return (
          <section key={group.parent?.id ?? "root"} aria-label={`Branches after: ${head}`}>
            <h3 className={styles.sectionHead}>{head}</h3>
            <ul className={styles.section} style={{ listStyle: "none" }}>
              {group.branches.map(({ node, onScreen, isLeaf, badges }) => {
                const time = nodeTime(node.at);
                const name = nodeName(node, time);
                return (
                  <li key={node.id} className={styles.listRow} data-kobe-tree-branch={node.id}>
                    <button
                      type="button"
                      className={styles.listOpen}
                      aria-label={name}
                      aria-current={onScreen ? "true" : undefined}
                      onClick={() => actions.run("show", node)}
                    >
                      {node.label !== undefined && (
                        <span className={styles.label}>{node.label} </span>
                      )}
                      {nodeText(node)}
                    </button>
                    {badgeTexts(badges).map((b) => (
                      <span key={b.kind} className={styles.badge}>
                        {b.shown}
                      </span>
                    ))}
                    {onScreen && <span className={styles.chip}>◀ on screen</span>}
                    {isLeaf && <span className={styles.chip}>leaf</span>}
                    <span className={styles.time}>{time}</span>
                    <NodeMenu
                      name={name}
                      items={actions.menuOf(node)}
                      open={menuFor === node.id}
                      onOpenChange={(open) => setMenuFor(open ? node.id : null)}
                      onPick={(item) => actions.run(item, node)}
                      focusable
                    />
                  </li>
                );
              })}
            </ul>
          </section>
        );
      })}
      {actions.below}
    </>
  );
}
