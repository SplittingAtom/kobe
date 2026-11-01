"use client";

import {
  ARCHIVED,
  CURRENT,
  DELETED,
  nodeKey,
  type PanelNode,
  type PlacedFolder,
  type TreeCounts,
} from "../../lib/chat/folder-tree";
import type { MenuBindings } from "../../lib/shell/menu";
import { ActionMenu } from "../ui/action-menu";

/** Indentation in a `<select>` option: no-break spaces, the only padding an option keeps. */
const indent = (levels: number) => "   ".repeat(levels);

interface Option {
  readonly node: PanelNode;
  readonly text: string;
}

function options(placed: readonly PlacedFolder[], counts: TreeCounts): readonly Option[] {
  return [
    { node: CURRENT, text: `Current (${counts.current})` },
    { node: ARCHIVED, text: `${indent(1)}Archived (${counts.archived})` },
    ...placed.map((p) => ({
      node: { kind: "folder", id: p.folder.id } as const,
      text: `${indent(p.depth - 1)}${p.folder.name} (${p.folder.threads})`,
    })),
    { node: DELETED, text: `Deleted (${counts.deleted})` },
  ];
}

/**
 * Under 820 px the tree is one dropdown above the list (KOBE-536, TF7): every node, its depth as
 * indentation (Archived under Current), with "+ New folder" beside it and the chosen folder's ⋯
 * menu, so every node action stays reachable.
 */
export function FolderPicker({
  placed,
  counts,
  chosen,
  choose,
  onNewFolder,
  chosenBindings,
  chosenName,
}: {
  readonly placed: readonly PlacedFolder[];
  readonly counts: TreeCounts;
  readonly chosen: PanelNode;
  choose(node: PanelNode): void;
  onNewFolder(): void;
  /** The chosen folder's ⋯ menu; null for Current, Archived and Deleted. */
  readonly chosenBindings: MenuBindings | null;
  readonly chosenName: string;
}) {
  const list = options(placed, counts);
  return (
    <div className="flex items-center gap-2">
      <select
        aria-label="Show threads in"
        data-kobe-folder-picker=""
        value={nodeKey(chosen)}
        onChange={(e) => {
          const next = list.find((o) => nodeKey(o.node) === e.target.value);
          if (next) choose(next.node);
        }}
        className="h-8 min-w-0 flex-1 rounded-md border bg-background px-2 text-sm"
      >
        {list.map((o) => (
          <option key={nodeKey(o.node)} value={nodeKey(o.node)}>
            {o.text}
          </option>
        ))}
      </select>
      {chosenBindings && (
        <ActionMenu
          trigger="folder-node-actions"
          label={`Actions for ${chosenName}`}
          scope="folder-menu"
          bindings={chosenBindings}
          size="md"
        />
      )}
      <button type="button" className="shrink-0 text-sm underline" onClick={onNewFolder}>
        + New folder
      </button>
    </div>
  );
}
