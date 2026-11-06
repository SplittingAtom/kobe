"use client";

import { useAui } from "@assistant-ui/react";
import { DropdownMenu } from "radix-ui";
import { EllipsisIcon } from "lucide-react";
import { useContext, useState, type FormEvent, type ReactNode } from "react";
import { forkPointOf, type ForkPoint } from "../../lib/chat/fork";
import { isThreadRunning } from "../../lib/chat/thread-state";
import { branchPointOfMeta, type KobeMessageMeta } from "../../lib/chat/tree";
import type { TreeNode, TreeProjection } from "../../lib/chat/tree-nodes";
import {
  FILES_LEFT_NOTE,
  LABEL_REMOVED,
  LABEL_SAVED,
  TREE_MENU_NAMES,
  checkLabel,
  filesLeftBehind,
  labelErrorMessage,
  nodeEntries,
  nodePath,
  treeMenu,
  type TreeMenuItem,
} from "../../lib/chat/tree-panel";
import { chatPortalContainer } from "../ui/chat-portal";
import { LEAF_BUSY_NOTE } from "./branch-bar";
import { ForkDialog } from "./fork-dialog";
import { ChatSessionContext, type KobeThreadExtras } from "./kobe-runtime";
import type { TreeData } from "./tree-context";
import styles from "./conversation-tree.module.css";

/** What the panel shows below the tree for one node: the label editor or a confirmation. */
export type TreeEditing =
  | { readonly kind: "label"; readonly node: TreeNode }
  | { readonly kind: "confirm-current"; readonly node: TreeNode };

/** Frames to wait for a message to show before opening its editor. */
const EDIT_FRAMES = 20;

function textOf(meta: KobeMessageMeta | undefined, content: unknown): string {
  if (meta?.kind === "user") return meta.text;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((p: { type?: string; text?: string }) => (p.type === "text" ? (p.text ?? "") : ""))
    .join("\n")
    .trim();
}

/** Focuses this window's composer (Continue from here, after the panel closed). */
export function focusComposerSoon(): void {
  requestAnimationFrame(() =>
    requestAnimationFrame(() =>
      document.querySelector<HTMLTextAreaElement>("[data-kobe-composer] textarea")?.focus(),
    ),
  );
}

/**
 * The node menu's actions (CT4, CT6, CT8, CT9), shared by the git-graph and the narrow list:
 * every item goes through the thread's controller (the head, Continue from here, Make it current)
 * or the label route; nothing else is written.
 */
export function useTreeActions(
  extras: KobeThreadExtras,
  tree: TreeProjection,
  data: TreeData,
  onClose: () => void,
) {
  const aui = useAui();
  const session = useContext(ChatSessionContext);
  const { controller, state, projection } = extras;
  const [editing, setEditing] = useState<TreeEditing | null>(null);
  const [forking, setForking] = useState<ForkPoint | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const summary = state.summary;
  const owner = summary?.readOnly !== true && controller !== null;
  const testThread = summary?.isTest === true;
  const leafPath = nodePath(tree.nodes, tree.leafId);
  const parents = new Map<string | null, number>();
  for (const n of tree.nodes) parents.set(n.parentId, (parents.get(n.parentId) ?? 0) + 1);

  const menuOf = (node: TreeNode): readonly TreeMenuItem[] => {
    const { meta } = nodeEntries(projection, node.id);
    return treeMenu(node, tree, {
      owner,
      testThread,
      inTrash: summary?.deletedAt != null,
      offLeafBranch: !leafPath.has(node.id),
      hasSiblings: (parents.get(node.parentId) ?? 0) > 1,
      canEdit: !isThreadRunning(state) && branchPointOfMeta(projection, meta) !== undefined,
      canRetry: node.empty === true && node.isLeaf && state.interruptedRun != null,
      forkable: forkPointOf(meta) !== undefined,
      compare: true,
    });
  };

  /** Shows the node's branch (head only) and scrolls to it; the panel closes. */
  const show = (node: TreeNode) => {
    const { first, last } = nodeEntries(projection, node.id);
    const at = first ?? last;
    if (at === undefined || controller === null) return;
    if (node.onScreen) controller.reveal(at);
    else controller.showBranch(last ?? at, at);
    onClose();
  };

  const makeCurrent = async (node: TreeNode) => {
    const { last } = nodeEntries(projection, node.id);
    if (last === undefined || controller === null) return;
    setEditing(null);
    controller.showBranch(last);
    const res = await controller.makeCurrent();
    if (res && !res.ok && res.error.code === "thread_busy") setNote(LEAF_BUSY_NOTE);
    else if (res?.ok) onClose();
  };

  const edit = (node: TreeNode) => {
    const { last } = nodeEntries(projection, node.id);
    if (last === undefined || controller === null) return;
    onClose();
    if (!node.onScreen) controller.showBranch(last);
    let frame = 0;
    const tryEdit = () => {
      const shown = aui.thread.getState().messages.some((m) => m.id === node.id);
      if (shown) aui.thread.message({ id: node.id }).composer().beginEdit();
      else if (++frame < EDIT_FRAMES) requestAnimationFrame(tryEdit);
    };
    requestAnimationFrame(tryEdit);
  };

  const copy = (node: TreeNode) => {
    const item = projection.items.find((i) => i.message.id === node.id);
    const { meta } = nodeEntries(projection, node.id);
    const text = textOf(meta, item?.message.content);
    void navigator.clipboard?.writeText(text).then(
      () => controller?.announce("Copied"),
      () => setNote("The text could not be copied."),
    );
  };

  const writeLabel = async (node: TreeNode, label: string | null): Promise<string | null> => {
    const { first } = nodeEntries(projection, node.id);
    const threadId = state.threadId;
    if (first === undefined || threadId === null || session === null) return null;
    const res = await session.api.setThreadLabel(threadId, first, label);
    if (!res.ok) return labelErrorMessage(res.error.code);
    data.replaceNotes(res.data);
    controller?.announce(label === null ? LABEL_REMOVED : LABEL_SAVED);
    return null;
  };

  const run = (item: TreeMenuItem, node: TreeNode) => {
    setNote(null);
    const { last, meta } = nodeEntries(projection, node.id);
    switch (item) {
      case "show":
        return show(node);
      case "make-current":
        if (filesLeftBehind(tree, node.id)) return setEditing({ kind: "confirm-current", node });
        return void makeCurrent(node);
      case "continue":
        if (last === undefined) return;
        controller?.continueFrom(last);
        onClose();
        return focusComposerSoon();
      case "edit":
        return edit(node);
      case "retry":
        onClose();
        return void controller?.retry();
      case "label":
        return setEditing({ kind: "label", node });
      case "remove-label":
        return void writeLabel(node, null).then((error) => setNote(error));
      case "fork": {
        const point = forkPointOf(meta);
        return point === undefined ? undefined : setForking(point);
      }
      case "copy":
        return copy(node);
      case "compare":
        // The dialog takes the window (CT10); the tree closes under it.
        onClose();
        return data.compare(node.id);
      case "carry-summary":
        // KOBE-548 adds this; hidden until then (`treeMenu`).
        return undefined;
    }
  };

  const below: ReactNode = (
    <>
      {note !== null && (
        <p className={styles.note} role="status" data-kobe-tree-note="">
          {note}
        </p>
      )}
      {editing?.kind === "label" && (
        <LabelEditor
          key={editing.node.id}
          node={editing.node}
          onCancel={() => setEditing(null)}
          onSave={async (label) => {
            const error = await writeLabel(editing.node, label);
            if (error === null) setEditing(null);
            return error;
          }}
        />
      )}
      {editing?.kind === "confirm-current" && (
        <div className={styles.editor} role="group" aria-label="Make it current">
          <p className={styles.note}>{FILES_LEFT_NOTE}</p>
          <button type="button" onClick={() => void makeCurrent(editing.node)}>
            Make it current
          </button>
          <button type="button" onClick={() => setEditing(null)}>
            Cancel
          </button>
        </div>
      )}
      {forking !== null && (
        <ForkDialog
          point={forking}
          defaultTitle={summary?.title ?? ""}
          onOpenChange={(open) => {
            if (!open) setForking(null);
          }}
        />
      )}
    </>
  );

  return { menuOf, run, below };
}

/** The inline label editor (CT9): 1-60 characters, trimmed, one line; refusals in fixed words. */
function LabelEditor({
  node,
  onSave,
  onCancel,
}: {
  readonly node: TreeNode;
  readonly onSave: (label: string) => Promise<string | null>;
  readonly onCancel: () => void;
}) {
  const [text, setText] = useState(node.label ?? "");
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (saving) return;
    const checked = checkLabel(text);
    if (!checked.ok) return setError(checked.message);
    setSaving(true);
    void onSave(checked.label).then((failed) => {
      setSaving(false);
      setError(failed);
    });
  };
  return (
    <form className={styles.editor} onSubmit={submit} data-kobe-label-editor="">
      <input
        aria-label="Label"
        aria-invalid={error !== null || undefined}
        // Opened on purpose from the menu: it takes the focus.
        autoFocus
        value={text}
        maxLength={80}
        onChange={(e) => {
          setText(e.target.value);
          setError(null);
        }}
        onKeyDown={(e) => {
          if (e.key === "Escape") {
            e.preventDefault();
            e.stopPropagation();
            onCancel();
          }
        }}
      />
      <button type="submit" aria-disabled={saving || undefined}>
        Save label
      </button>
      <button type="button" onClick={onCancel}>
        Cancel
      </button>
      {error !== null && (
        <p className={styles.error} role="alert">
          {error}
        </p>
      )}
    </form>
  );
}

const CONTENT = "bg-background text-foreground z-50 min-w-48 rounded-lg border p-1 shadow-md";
const ITEM =
  "hover:bg-muted focus:bg-muted flex cursor-pointer items-center rounded-md px-2 py-1.5 text-sm outline-none select-none";

/** The ⋯ of a row: the node's menu (Radix, in the chat's portal). */
export function NodeMenu({
  name,
  items,
  open,
  onOpenChange,
  onPick,
  focusable = false,
}: {
  /** In the narrow list the ⋯ is a tab stop (the wide tree reaches it by the context-menu key). */
  readonly focusable?: boolean;
  readonly name: string;
  readonly items: readonly TreeMenuItem[];
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly onPick: (item: TreeMenuItem) => void;
}) {
  return (
    <DropdownMenu.Root open={open} onOpenChange={onOpenChange}>
      <DropdownMenu.Trigger asChild>
        <button
          type="button"
          tabIndex={focusable ? 0 : -1}
          aria-label={`Actions for ${name}`}
          className={`${styles.more} hover:bg-muted inline-flex size-6 items-center justify-center rounded-md`}
          onClick={(e) => e.stopPropagation()}
          onKeyDown={(e) => e.stopPropagation()}
        >
          <EllipsisIcon aria-hidden className="size-4" />
        </button>
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal container={chatPortalContainer()}>
        {/* Portaled, but React events still bubble to the row: they stop here. */}
        <DropdownMenu.Content
          data-kobe-portal
          align="end"
          sideOffset={4}
          className={CONTENT}
          onClick={(e) => e.stopPropagation()}
          onKeyDown={(e) => e.stopPropagation()}
        >
          {items.map((item) => (
            <DropdownMenu.Item key={item} className={ITEM} onSelect={() => onPick(item)}>
              {TREE_MENU_NAMES[item]}
            </DropdownMenu.Item>
          ))}
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}
