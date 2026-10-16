/**
 * `@file` mentions in the composer (CE22, KOBE-223). A picked file goes into the message text as
 * the protocol's marker, `@file(<path>)`; the server resolves it against the owner's workspace and
 * rewrites it to the absolute `/workspace/...` path on send (never the client). These helpers
 * read the markers back for the chips and give assistant-ui's trigger popover its formatter.
 */
import type { DirectiveFormatter, DirectiveSegment, TriggerItem } from "@assistant-ui/react";
import {
  decodeMentionPath,
  findMentionMarkers,
  mentionMarker,
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

/** The mentions in a composer text, in order, one per distinct marker. */
export function mentionsIn(text: string): readonly ComposerMention[] {
  const seen = new Set<string>();
  const out: ComposerMention[] = [];
  for (const m of findMentionMarkers(text)) {
    const path = decodeMentionPath(m.encoded);
    if (path === undefined || seen.has(m.raw)) continue;
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
