"use client";

import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { formatTokens } from "../../lib/admin/usage-format";
import { UNTITLED_THREAD } from "../../lib/chat/fork";
import { headOf, isBrowsing } from "../../lib/chat/head";
import { liveOverlay } from "../../lib/chat/thread-state";
import { createTreeLayout, type TreeLayout, type TreeRow } from "../../lib/chat/tree-layout";
import { treeForks, type TreeFork } from "../../lib/chat/tree-forks";
import {
  junctionCount,
  projectTree,
  type TreeNode,
  type TreeNotes,
  type TreeProjection,
} from "../../lib/chat/tree-nodes";
import {
  COMPACTED_TEXT,
  EMPTY_TREE_NOTE,
  SUMMARY_TEXT,
  TREE_HELP_TEXT,
  badgeTexts,
  headerCounts,
  matchesFilter,
  moveFocus,
  nodeName,
  nodeText,
  nodeTime,
  siblingsOf,
  type TreeKey,
} from "../../lib/chat/tree-panel";
import type { Panel } from "../../lib/shell/panels";
import { useShellBand } from "../shell/shell-band";
import { WorkspacePanel } from "../shell/workspace-panel";
import { OpenThreadContext } from "./fork-dialog";
import type { KobeThreadExtras } from "./kobe-runtime";
import { useMarkerData } from "./markers";
import { NodeMenu, useTreeActions } from "./tree-actions";
import type { TreeData } from "./tree-context";
import { TreeList } from "./tree-list";
import styles from "./conversation-tree.module.css";

const PANEL: Panel = { id: "conversation-tree", title: "Conversation tree", embedded: true };

/** One row's height and one lane's width in the SVG, px (`.row` sets 2rem). */
const ROW_H = 32;
const LANE_W = 16;
const NODE_R = 5;
const MY_MEMORY = "/me/memory";
const TEAM_RULES = "/admin/team/policy";

const KEYS: ReadonlySet<string> = new Set([
  "ArrowUp",
  "ArrowDown",
  "ArrowLeft",
  "ArrowRight",
  "Home",
  "End",
]);

/** The tree of the thread on screen, its layout and forks, memoised as CT4 asks. */
export function useTreeModel(extras: KobeThreadExtras, data: TreeData) {
  const { state } = extras;
  const { agentsAt } = useMarkerData();
  const agents = useMemo(() => [...agentsAt.values()].flat(), [agentsAt]);
  const notes = useMemo<TreeNotes>(() => ({ ...data.notes, agents }), [data.notes, agents]);
  const head = headOf(state);
  const leaf = state.summary?.leafEntryId ?? null;
  const overlay = isBrowsing(state) ? undefined : liveOverlay(state);
  const tree = useMemo(
    () => projectTree(state.entries, head, leaf, notes, overlay),
    // `overlay` is rebuilt on every render; depend on its sources (as the runtime does).
    [state.entries, head, leaf, notes, state.live, state.livePrompt, state.sending, state.runs],
  );
  const forkList = data.lineage?.forks;
  const forks = useMemo(
    () => treeForks(forkList ?? [], tree.nodeOfEntry),
    [forkList, tree.nodeOfEntry],
  );
  const layoutFn = useRef(createTreeLayout());
  const layout = layoutFn.current(state.entries, head, tree, forks.placed);
  const junctions = useMemo(() => junctionCount(state.entries), [state.entries]);
  return { tree, layout, forks, junctions, forkCount: forkList?.length ?? 0 };
}

function Graph({ layout, nodes }: { readonly layout: TreeLayout; readonly nodes: ReadonlyMap<string, TreeNode> }) {
  const x = (lane: number) => (lane - 0.5) * LANE_W;
  const y = (row: number) => row * ROW_H + ROW_H / 2;
  return (
    <svg
      aria-hidden="true"
      className={styles.graph}
      width={layout.lanes * LANE_W + 4}
      height={layout.rows.length * ROW_H}
      data-kobe-tree-graph=""
    >
      {layout.rows.map((r) =>
        r.parentRow === null || r.parentLane === null ? null : (
          <path
            key={`l-${r.id}`}
            d={`M ${x(r.parentLane)} ${y(r.parentRow)} Q ${x(r.lane)} ${y(r.parentRow)} ${x(r.lane)} ${y(r.parentRow) + ROW_H / 2} L ${x(r.lane)} ${y(r.row)}`}
            fill="none"
            strokeWidth={1.5}
            strokeDasharray={r.kind === "fork" || nodes.get(r.id)?.pending ? "4 3" : r.dotted ? "1 3" : undefined}
            style={{ stroke: `var(--kobe-lane-${r.lane})` }}
          />
        ),
      )}
      {layout.rows.map((r) => {
        const node = nodes.get(r.id);
        if (node === undefined) return null;
        const hollow = node.empty === true || node.pending === true;
        return (
          <circle
            key={`n-${r.id}`}
            cx={x(r.lane)}
            cy={y(r.row)}
            r={NODE_R}
            className={`${hollow ? styles.hollow : styles.node} ${node.live ? styles.live : ""}`}
            style={hollow ? undefined : { color: `var(--kobe-lane-${r.lane})` }}
            data-kobe-tree-node={r.id}
          />
        );
      })}
    </svg>
  );
}

function Trail({ node }: { readonly node: TreeNode }) {
  const parts = [
    node.role === "assistant" ? node.model : null,
    node.role === "assistant" && node.tokens !== null
      ? `${formatTokens(node.tokens.input + node.tokens.output)} tokens`
      : null,
    node.agentVersion ? `${node.agentVersion.name} v${node.agentVersion.version}` : null,
  ].filter((p): p is string => p !== null && p !== "");
  const badges = badgeTexts(node.badges);
  return (
    <>
      {parts.length > 0 && <span className={styles.trail}> · {parts.join(" · ")}</span>}
      {badges.map((b) => (
        <span key={b.kind} className={styles.badge}>
          {" · "}
          {b.kind === "files" ? (
            <span title={(node.badges.paths ?? []).join("\n")}>{b.shown}</span>
          ) : (
            <a
              href={b.kind === "memories" ? MY_MEMORY : TEAM_RULES}
              tabIndex={-1}
              title={b.kind === "memories" ? "My memory" : "The team's approval rules"}
              onClick={(e) => e.stopPropagation()}
            >
              {b.shown}
            </a>
          )}
        </span>
      ))}
      {node.summary && <span className={styles.trail}> · {SUMMARY_TEXT}</span>}
      {node.compacted && <span className={styles.trail}> · {COMPACTED_TEXT}</span>}
    </>
  );
}

/** The wide view (CT4): the SVG git-graph and one HTML row per node or fork, as a role=tree. */
function TreeGraph({
  extras,
  data,
  model,
  onClose,
  onOpenThread,
}: {
  readonly extras: KobeThreadExtras;
  readonly data: TreeData;
  readonly model: ReturnType<typeof useTreeModel>;
  readonly onClose: () => void;
  readonly onOpenThread: ((threadId: string) => void) | undefined;
}) {
  const { tree, layout, forks } = model;
  const actions = useTreeActions(extras, tree, data, onClose);
  const [filter, setFilter] = useState("");
  const [focus, setFocus] = useState<string | undefined>(tree.headId ?? undefined);
  const [menuFor, setMenuFor] = useState<string | null>(null);
  const filterRef = useRef<HTMLInputElement>(null);
  const rowRefs = useRef(new Map<string, HTMLDivElement>());
  const moved = useRef(false);
  const nodes = useMemo(() => new Map(tree.nodes.map((n) => [n.id, n] as const)), [tree.nodes]);
  const forkById = useMemo(
    () => new Map(forks.placed.map((f) => [f.id, f] as const)),
    [forks.placed],
  );
  const siblings = useMemo(() => siblingsOf(tree.nodes), [tree.nodes]);
  const ids = layout.rows.map((r) => r.id);
  const current = focus !== undefined && ids.includes(focus) ? focus : (tree.headId ?? ids[0]);
  useEffect(() => {
    if (!moved.current || current === undefined) return;
    moved.current = false;
    rowRefs.current.get(current)?.focus();
  }, [current]);

  // The host closes the panel onto the fork (its address becomes the fork's).
  const openFork = (fork: TreeFork) => onOpenThread?.(fork.threadId);
  const activate = (id: string) => {
    const fork = forkById.get(id);
    if (fork) return openFork(fork);
    const node = nodes.get(id);
    if (node) actions.run("show", node);
  };
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.target instanceof HTMLInputElement) return;
    if (KEYS.has(e.key)) {
      e.preventDefault();
      moved.current = true;
      setFocus(moveFocus(ids, current, e.key as TreeKey, siblings, tree.leafId));
    } else if (e.key === "Enter" && current !== undefined) {
      e.preventDefault();
      activate(current);
    } else if (e.key === "/") {
      e.preventDefault();
      filterRef.current?.focus();
    } else if ((e.key === "ContextMenu" || (e.key === "F10" && e.shiftKey)) && current) {
      e.preventDefault();
      if (nodes.has(current)) setMenuFor(current);
    }
  };

  const row = (r: TreeRow) => {
    const fork = forkById.get(r.id);
    const node = nodes.get(r.id);
    const selected = r.id === current;
    const common = {
      ref: (el: HTMLDivElement | null) => {
        if (el) rowRefs.current.set(r.id, el);
        else rowRefs.current.delete(r.id);
      },
      role: "treeitem",
      "aria-level": r.lane,
      "aria-selected": selected,
      tabIndex: selected ? 0 : -1,
      style: { paddingInlineStart: `${layout.lanes * LANE_W + 8}px` },
      onFocus: () => setFocus(r.id),
      onClick: () => activate(r.id),
    } as const;
    if (fork) {
      const title = fork.title ?? UNTITLED_THREAD;
      return (
        <div key={r.id} {...common} className={`${styles.row} ${styles.fork}`} aria-label={`Fork, ${title}`} data-kobe-tree-row={r.id}>
          <span className={styles.text}>
            ⑂ {title} <span className={styles.trail}>(fork, another thread)</span>
          </span>
        </div>
      );
    }
    if (!node) return null;
    const time = nodeTime(node.at);
    const dim = !matchesFilter(node, filter);
    const items = actions.menuOf(node);
    const name = nodeName(node, time);
    return (
      <div
        key={r.id}
        {...common}
        aria-label={name}
        aria-current={node.id === tree.headId ? "true" : undefined}
        className={`${styles.row} ${node.role === "assistant" ? styles.assistant : ""} ${node.empty ? styles.ghost : ""} ${dim ? styles.dimmed : ""}`}
        data-kobe-tree-row={r.id}
        data-dimmed={dim || undefined}
      >
        <span className={styles.text}>
          {node.label !== undefined && <span className={styles.label}>{node.label} </span>}
          {nodeText(node)}
          {node.role === "assistant" && <Trail node={node} />}
        </span>
        {node.id === tree.headId && <span className={styles.chip}>◀ on screen</span>}
        {node.isLeaf && <span className={styles.chip}>leaf</span>}
        <span className={styles.time}>{time}</span>
        <NodeMenu
          name={name}
          items={items}
          open={menuFor === node.id}
          onOpenChange={(open) => setMenuFor(open ? node.id : null)}
          onPick={(item) => actions.run(item, node)}
        />
      </div>
    );
  };

  return (
    <>
      <input
        ref={filterRef}
        type="search"
        aria-label="Filter the tree"
        placeholder="Filter"
        className={styles.filter}
        value={filter}
        onChange={(e) => setFilter(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "ArrowDown" || e.key === "Enter") {
            e.preventDefault();
            moved.current = true;
            setFocus(current);
            rowRefs.current.get(current ?? "")?.focus();
          }
        }}
      />
      {/* The rows carry the content; the SVG under them is decoration (aria-hidden). */}
      <div
        role="tree"
        aria-label="Branches of this conversation"
        className={styles.tree}
        onKeyDown={onKeyDown}
        data-kobe-tree=""
      >
        <Graph layout={layout} nodes={nodes} />
        {layout.rows.map(row)}
      </div>
      {actions.below}
    </>
  );
}

/**
 * The Conversation tree panel (CT4, CT18; KOBE-546): a panel over the workspace like Threads and
 * the context viewer (the chat stays mounted under it; Escape and Close return to it). The header
 * names the thread, counts branches (junctions) and forks; the body is the git-graph, or under
 * 820 px the list grouped by junction.
 */
export function ConversationTreePanel({
  extras,
  data,
  onClose,
  onOpenThread,
}: {
  readonly extras: KobeThreadExtras;
  readonly data: TreeData;
  readonly onClose: () => void;
  readonly onOpenThread?: ((threadId: string) => void) | undefined;
}) {
  const band = useShellBand();
  const narrow = band === "overlay" || band === "single";
  const model = useTreeModel(extras, data);
  const straight = model.junctions === 0 && model.forkCount === 0;
  const title = extras.state.summary?.title || UNTITLED_THREAD;
  return (
    <WorkspacePanel panel={PANEL} path="/tree" onClose={onClose}>
      <OpenThreadContext.Provider value={onOpenThread}>
        <div className={styles.view} data-kobe-tree-panel={narrow ? "list" : "graph"}>
          <div className={styles.toolbar}>
            <p className={styles.title}>{title}</p>
            <p className={styles.counts}>{headerCounts(model.junctions, model.forkCount)}</p>
          </div>
          {straight && !narrow && <p className={styles.note}>{EMPTY_TREE_NOTE}</p>}
          <p className={styles.note}>{TREE_HELP_TEXT}</p>
          {narrow ? (
            <TreeList extras={extras} data={data} tree={model.tree} onClose={onClose} />
          ) : (
            <TreeGraph
              extras={extras}
              data={data}
              model={model}
              onClose={onClose}
              onOpenThread={onOpenThread}
            />
          )}
        </div>
      </OpenThreadContext.Provider>
    </WorkspacePanel>
  );
}

export type { TreeProjection };
