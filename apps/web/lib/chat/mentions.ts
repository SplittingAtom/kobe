/**
 * `@file` mentions in the composer (CE22, KOBE-223). A picked file goes into the message text as
 * the protocol's marker, `@file(<path>)`, and into the draft's picked set ({@link MentionStore});
 * a send lists the picked paths whose marker is still in the text (`mentions`), and the server
 * rewrites exactly those markers to absolute `/workspace/...` paths. A typed or pasted
 * `@file(...)` is never picked, so it stays literal text.
 */
import type { DirectiveFormatter, DirectiveSegment, TriggerItem } from "@assistant-ui/react";
import {
  decodeMentionPath,
  findMentionMarkers,
  mentionMarker,
  mentionPathIssue,
  sandboxPathOf,
} from "@kobe/protocol";
import type { FileEntry } from "../files/api";

/** The trigger character of file mentions (`/` is the command menu's, KOBE-224). */
export const MENTION_TRIGGER = "@";
/** The `TriggerItem.type` of a workspace file. */
export const MENTION_ITEM_TYPE = "file";

export interface ComposerMention {
  /** The marker as written in the text. */
  readonly raw: string;
  /** Relative to `/workspace`. */
  readonly path: string;
  readonly name: string;
  /** Where the agent will find it. */
  readonly sandboxPath: string;
}

const nameOf = (path: string) => path.slice(path.lastIndexOf("/") + 1);

/**
 * The picked mentions in a composer text, in order, one per distinct marker: markers of paths in
 * `picked` written exactly as the picker writes them (anything else is literal text).
 */
export function mentionsIn(text: string, picked: ReadonlySet<string>): readonly ComposerMention[] {
  const seen = new Set<string>();
  const out: ComposerMention[] = [];
  for (const m of findMentionMarkers(text)) {
    const path = decodeMentionPath(m.encoded);
    if (path === undefined || seen.has(m.raw) || !picked.has(path)) continue;
    if (m.raw !== mentionMarker(path)) continue;
    seen.add(m.raw);
    out.push({ raw: m.raw, path, name: nameOf(path), sandboxPath: sandboxPathOf(path) });
  }
  return out;
}

/** `text` without every copy of the marker `raw` (and the space the picker put after it). */
export function withoutMention(text: string, raw: string): string {
  return text.split(`${raw} `).join("").split(raw).join("");
}

/**
 * The query of an `@` being typed at `caret`, as assistant-ui's default trigger detection reads
 * it (the `@` starts the text or follows whitespace; no whitespace after it), or null.
 */
export function mentionQueryAt(text: string, caret: number): string | null {
  const upTo = text.slice(0, caret);
  for (let i = upTo.length - 1; i >= 0; i -= 1) {
    const c = upTo[i] ?? "";
    if (/\s/u.test(c)) return null;
    if (c === MENTION_TRIGGER && (i === 0 || /\s/u.test(upTo[i - 1] ?? ""))) {
      return upTo.slice(i + 1);
    }
  }
  return null;
}

/** Whether the picker may offer a file: never one whose name holds invisible characters (B1). */
export function mentionable(entry: FileEntry): boolean {
  return entry.type === "file" && mentionPathIssue(entry.path) === undefined;
}

const NO_PICKS: ReadonlySet<string> = new Set();

/**
 * The files picked with `@` per composer draft (the thread id, or the new-thread draft), for this
 * tab. Picks are only ever added by the picker; a send lists those still marked in the text.
 */
export class MentionStore {
  #picked = new Map<string, ReadonlySet<string>>();
  readonly #listeners = new Set<() => void>();

  readonly subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  };

  readonly get = (draft: string): ReadonlySet<string> => this.#picked.get(draft) ?? NO_PICKS;

  add(draft: string, path: string): void {
    this.#set(draft, new Set([...this.get(draft), path]));
  }

  /** The picked paths whose marker is in `text`: the send's `mentions`. */
  forText(draft: string, text: string): string[] {
    return mentionsIn(text, this.get(draft)).map((m) => m.path);
  }

  clear(draft: string): void {
    if (this.#picked.has(draft)) this.#set(draft, undefined);
  }

  /** A new thread was created by a send that failed: the picks follow the draft to it. */
  move(from: string, to: string): void {
    const picks = this.#picked.get(from);
    if (picks === undefined) return;
    this.#set(from, undefined);
    this.#set(to, picks);
  }

  #set(draft: string, picks: ReadonlySet<string> | undefined): void {
    const next = new Map(this.#picked);
    if (picks === undefined) next.delete(draft);
    else next.set(draft, picks);
    this.#picked = next;
    for (const l of this.#listeners) l();
  }
}

/** A workspace file as an item of the picker. */
export function fileItem(entry: FileEntry): TriggerItem {
  const folder = entry.path.slice(0, Math.max(0, entry.path.lastIndexOf("/")));
  return {
    id: entry.path,
    type: MENTION_ITEM_TYPE,
    label: entry.name,
    description: folder === "" ? "/workspace" : sandboxPathOf(folder),
    metadata: { area: entry.area },
  };
}

/** Writes and reads `@file(...)` markers for the trigger popover's directive behaviour. */
export const mentionFormatter: DirectiveFormatter = {
  serialize: (item) => mentionMarker(item.id),
  parse(text) {
    const segments: DirectiveSegment[] = [];
    let at = 0;
    for (const m of findMentionMarkers(text)) {
      const path = decodeMentionPath(m.encoded);
      if (path === undefined) continue;
      if (m.index > at) segments.push({ kind: "text", text: text.slice(at, m.index) });
      segments.push({ kind: "mention", type: MENTION_ITEM_TYPE, label: nameOf(path), id: path });
      at = m.index + m.raw.length;
    }
    if (at < text.length) segments.push({ kind: "text", text: text.slice(at) });
    return segments;
  },
};
