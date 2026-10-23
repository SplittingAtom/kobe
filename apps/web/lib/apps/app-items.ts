import {
  GENERIC_ITEM_KIND,
  ITEM_KIND_META_KEY,
  ITEM_KIND_PATTERN,
  ITEM_REFERENCES_MAX,
  itemReferenceNameSchema,
  type ItemReference,
} from "@kobe/protocol";
import { z } from "zod";

/**
 * Items an MCP App puts in the composer (KOBE-490): MCP `resource_link` blocks in a `ui/message`,
 * each a removable chip in the chip row of that thread's composer, de-duplicated by uri. Generic:
 * any app, any uri scheme but script-like ones. Chips never send anything by themselves; the
 * member's next message names the ones still shown (`references`).
 */
export const ITEM_URI_MAX = 2048;
export const ITEM_TITLE_MAX = 512;
/** Schemes a link may never use (they run or embed content). */
const REFUSED_SCHEMES = new Set(["javascript", "data", "vbscript"]);

/** One resource_link as Kobe keeps it: its kind is generic when unknown. */
export interface LinkedItem {
  readonly uri: string;
  readonly name: string;
  readonly kind: string;
  readonly title?: string | undefined;
}

/** One chip: the item and the app's title, for "from …". */
export interface AppItem extends LinkedItem {
  readonly from: string;
}

/** No space, control or format characters; a scheme first. */
const URI_PATTERN = /^([a-z][a-z0-9+.-]*):[^\s\p{Cc}\p{Cf}]+$/iu;

const uriSchema = z
  .string()
  .max(ITEM_URI_MAX)
  .refine((uri) => {
    const scheme = URI_PATTERN.exec(uri)?.[1]?.toLowerCase();
    return scheme !== undefined && !REFUSED_SCHEMES.has(scheme);
  }, "uri");

/** A resource_link block (MCP 2025-06-18), every field Kobe reads bounded. */
export const resourceLinkSchema = z.looseObject({
  type: z.literal("resource_link"),
  uri: uriSchema,
  name: itemReferenceNameSchema,
  title: z.string().max(ITEM_TITLE_MAX).optional(),
  mimeType: z.string().max(256).optional(),
  _meta: z.record(z.string(), z.unknown()).optional(),
});

/** The kind from `_meta["io.kobe/item-kind"]`, else generic. */
function kindOf(meta: Record<string, unknown> | undefined): string {
  const kind = meta?.[ITEM_KIND_META_KEY];
  return typeof kind === "string" && ITEM_KIND_PATTERN.test(kind) ? kind : GENERIC_ITEM_KIND;
}

/** Invisible and bidi characters could make a hover title read differently. */
const cleanTitle = (title: string | undefined) => {
  const line = title
    ?.replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
  return line === "" ? undefined : line;
};

/**
 * The usable resource_links of a `ui/message`'s content (first {@link ITEM_REFERENCES_MAX},
 * unique by uri) and how many link blocks were dropped as invalid or extra.
 */
export function appItemsOf(content: readonly Record<string, unknown>[]): {
  readonly items: readonly LinkedItem[];
  readonly dropped: number;
} {
  const links = content.filter((b) => b["type"] === "resource_link");
  const items: LinkedItem[] = [];
  for (const block of links) {
    const parsed = resourceLinkSchema.safeParse(block);
    if (!parsed.success || items.length >= ITEM_REFERENCES_MAX) continue;
    if (items.some((i) => i.uri === parsed.data.uri)) continue;
    const title = cleanTitle(parsed.data.title);
    items.push({
      uri: parsed.data.uri,
      name: parsed.data.name,
      kind: kindOf(parsed.data._meta),
      ...(title === undefined ? {} : { title }),
    });
  }
  return { items, dropped: links.length - items.length };
}

/** "Table", "View", … for the accessible name; unknown kinds read "Item". */
export function kindLabel(kind: string): string {
  return kind.charAt(0).toUpperCase() + kind.slice(1).replace(/-/g, " ");
}

/** The chips' `references` for the message body: names and kinds, unique. */
export function referencesBody(items: readonly AppItem[]): ItemReference[] {
  const seen = new Set<string>();
  return items
    .map((i) => ({ name: i.name, kind: i.kind }))
    .filter((r) => {
      const key = `${r.kind}\u0000${r.name}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .slice(0, ITEM_REFERENCES_MAX);
}

type Listener = () => void;
interface DraftItems {
  readonly items: readonly AppItem[];
  /** Shown when an app sent links and none was usable; cleared by the next change. */
  readonly note?: string | undefined;
}
const NONE: DraftItems = { items: [] };

/** Chips per composer draft (the thread id or NEW_DRAFT), observable. Every change makes new objects. */
export class AppItemStore {
  #byDraft: ReadonlyMap<string, DraftItems> = new Map();
  #listeners: readonly Listener[] = [];

  subscribe = (listener: Listener): (() => void) => {
    this.#listeners = [...this.#listeners, listener];
    return () => {
      this.#listeners = this.#listeners.filter((l) => l !== listener);
    };
  };

  #put(draft: string, next: DraftItems) {
    const map = new Map(this.#byDraft);
    if (next.items.length === 0 && next.note === undefined) map.delete(draft);
    else map.set(draft, next);
    this.#byDraft = map;
    for (const l of this.#listeners) l();
  }

  /** Adds the items not shown yet (by uri), at most {@link ITEM_REFERENCES_MAX} in all. */
  add(draft: string, items: readonly AppItem[]): boolean {
    const current = this.snapshot(draft).items;
    const fresh = items.filter(
      (item, i) =>
        !current.some((c) => c.uri === item.uri) &&
        items.findIndex((o) => o.uri === item.uri) === i,
    );
    const room = ITEM_REFERENCES_MAX - current.length;
    if (room <= 0 && fresh.length > 0) return false;
    this.#put(draft, { items: [...current, ...fresh.slice(0, Math.max(room, 0))] });
    return true;
  }

  /** The app sent links and none was usable: a note in the chip row, nothing else. */
  refused(draft: string, from: string): void {
    this.#put(draft, {
      items: this.snapshot(draft).items,
      note: `${from} sent items Kobe could not use.`,
    });
  }

  remove(draft: string, uri: string): void {
    const current = this.snapshot(draft);
    if (!current.items.some((i) => i.uri === uri)) return;
    this.#put(draft, { items: current.items.filter((i) => i.uri !== uri) });
  }

  /** After a send: drops the chips that went; one an app added meanwhile stays. */
  removeSent(draft: string, sent: readonly AppItem[]): void {
    const current = this.snapshot(draft).items;
    const left = current.filter((i) => !sent.includes(i));
    if (left.length === current.length && this.snapshot(draft).note === undefined) return;
    this.#put(draft, { items: left });
  }

  clear(draft: string): void {
    if (this.#byDraft.has(draft)) this.#put(draft, NONE);
  }

  /** A new conversation's chips follow it when its first message did not go (KOBE-194). */
  move(from: string, to: string): void {
    const items = this.snapshot(from).items;
    if (items.length === 0) return;
    this.clear(from);
    this.add(to, items);
  }

  /** A stable snapshot (the same object until the draft's chips change). */
  snapshot(draft: string): DraftItems {
    return this.#byDraft.get(draft) ?? NONE;
  }

  forDraft(draft: string): readonly AppItem[] {
    return this.snapshot(draft).items;
  }
}
