"use client";

import {
  BoxIcon,
  Columns3Icon,
  EyeIcon,
  FileIcon,
  FileTextIcon,
  FolderIcon,
  FolderTreeIcon,
  LayoutDashboardIcon,
  LibraryIcon,
  SquareCodeIcon,
  TableIcon,
  XIcon,
  type LucideIcon,
} from "lucide-react";
import { useSyncExternalStore } from "react";
import { kindLabel } from "../../lib/apps/app-items";
import { useChatSession } from "../chat/kobe-runtime";

/** The icon per `io.kobe/item-kind` (KOBE-490); anything else is generic. */
const ICONS: Readonly<Record<string, LucideIcon>> = {
  catalog: LibraryIcon,
  namespace: FolderTreeIcon,
  schema: FolderTreeIcon,
  table: TableIcon,
  view: EyeIcon,
  column: Columns3Icon,
  file: FileIcon,
  folder: FolderIcon,
  query: SquareCodeIcon,
  dashboard: LayoutDashboardIcon,
  document: FileTextIcon,
};

export function itemIcon(kind: string): LucideIcon {
  return ICONS[kind] ?? BoxIcon;
}

const CHIP =
  "inline-flex max-w-full min-w-0 items-center gap-1.5 rounded-full border px-2 py-0.5 text-xs";

/** One item's look: its kind's icon and its name; the hover spells out the full name sent. */
export function ItemChipBody({ kind, name }: { readonly kind: string; readonly name: string }) {
  const Icon = itemIcon(kind);
  return (
    <>
      <Icon
        aria-hidden
        data-kobe-item-icon={ICONS[kind] ? kind : "generic"}
        className="size-3 shrink-0"
      />
      <span className="sr-only">{kindLabel(kind)} </span>
      <span className="truncate" title={name}>
        {name}
      </span>
    </>
  );
}

/**
 * The composer's item chips (KOBE-490): what MCP Apps put in this draft with `ui/message`
 * resource_links, each with its kind's icon and removable (× or Delete/Backspace on it). Only the
 * chips shown here go with the next message, as references; they never send anything themselves.
 */
export function AppItemChips({ draft }: { readonly draft: string }) {
  const store = useChatSession().appItems;
  const { items, note } = useSyncExternalStore(
    store.subscribe,
    () => store.snapshot(draft),
    () => store.snapshot(draft),
  );
  if (items.length === 0 && note === undefined) return null;
  return (
    <div className="flex flex-col gap-1 px-2">
      {items.length > 0 && (
        <ul
          aria-label="Items sent with your next message"
          className="m-0 flex list-none flex-wrap gap-1 p-0"
        >
          {items.map((item) => {
            const from = item.from === "" ? "" : `, from ${item.from}`;
            const label = `${kindLabel(item.kind)} ${item.name}${from}; remove`;
            return (
              <li key={item.uri} data-kobe-app-item={item.kind} className={CHIP}>
                <ItemChipBody kind={item.kind} name={item.name} />
                <button
                  type="button"
                  aria-label={label}
                  className="rounded-full p-0"
                  onClick={() => store.remove(draft, item.uri)}
                  onKeyDown={(e) => {
                    if (e.key !== "Delete" && e.key !== "Backspace") return;
                    e.preventDefault();
                    store.remove(draft, item.uri);
                  }}
                >
                  <XIcon aria-hidden className="size-3" />
                </button>
              </li>
            );
          })}
        </ul>
      )}
      {note !== undefined && (
        <p role="note" className="text-muted-foreground m-0 text-xs">
          {note}
        </p>
      )}
    </div>
  );
}

/** The chips a sent message referenced (the server's line, KOBE-490), under its text. */
export function SentItemChips({
  references,
}: {
  readonly references: readonly { readonly name: string; readonly kind: string }[];
}) {
  if (references.length === 0) return null;
  return (
    <ul aria-label="Referenced items" className="m-0 mt-1 flex list-none flex-wrap gap-1 p-0">
      {references.map((r) => (
        <li key={`${r.kind}:${r.name}`} data-kobe-sent-item={r.kind} className={CHIP}>
          <ItemChipBody kind={r.kind} name={r.name} />
        </li>
      ))}
    </ul>
  );
}
