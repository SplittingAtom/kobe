/**
 * "Fork to a new thread" (CE16, KOBE-216): which entry a message forks at, and how a fork names
 * where it came from. The server decides what the viewer may see: a fork names its source only
 * while the viewer may open it (`forkedFromThreadId`), and its fork point is an entry of the fork
 * itself, so it is looked up in the fork's own projection, never in the source.
 */
import type { KobeMessageMeta, Projection } from "./tree";
import type { ThreadSummary } from "./types";

/** Longest excerpt of the fork point's message in the origin marker. */
const EXCERPT_MAX = 80;

/** Neutral text for a fork whose source the viewer can't open (or that no longer exists). */
export const HIDDEN_SOURCE = "a thread you can't open";

/** Where a message forks: the entry the fork ends at, and a prompt to re-send there. */
export interface ForkPoint {
  readonly entryId: string;
  /** Forking at a prompt: its text, put in the new thread's composer (not sent). */
  readonly draft?: string;
}

/**
 * Where a message forks. An answer: at its last entry (its tool calls and results come along). A
 * prompt: at the entry before it, with the prompt as the new thread's draft, so the fork doesn't
 * end on an unanswered prompt (the next send would chain two user turns). None while a prompt is
 * pending or an answer is still being written, nor for a prompt with nothing above it.
 */
export function forkPointOf(meta: KobeMessageMeta | undefined): ForkPoint | undefined {
  if (meta?.kind === "user") {
    if (meta.pending || meta.entryId === undefined || meta.parentEntryId === null) return undefined;
    return { entryId: meta.parentEntryId, draft: meta.text };
  }
  if (meta?.kind === "assistant") {
    const last = meta.live ? undefined : meta.entryIds.at(-1);
    return last === undefined ? undefined : { entryId: last };
  }
  return undefined;
}

export type ForkOrigin =
  | {
      readonly kind: "source";
      readonly threadId: string;
      readonly title: string | null;
      readonly at: string | null;
    }
  | { readonly kind: "hidden"; readonly at: string };

/** Where the thread was forked from; null for a thread that is not a fork. */
export function forkOrigin(summary: ThreadSummary | null | undefined): ForkOrigin | null {
  if (!summary) return null;
  const at = summary.forkedAtEntryId ?? null;
  if (summary.forkedFromThreadId) {
    return {
      kind: "source",
      threadId: summary.forkedFromThreadId,
      title: summary.forkedFromTitle ?? null,
      at,
    };
  }
  return at === null ? null : { kind: "hidden", at };
}

/** The source's name as shown ("Untitled conversation" when it has no title). */
export function sourceName(origin: ForkOrigin): string {
  return origin.kind === "source" ? (origin.title ?? "Untitled conversation") : HIDDEN_SOURCE;
}

/** The rail's hover text for a thread's list item (assistant-ui `custom.fork`). */
export function forkHint(origin: ForkOrigin | null): string | undefined {
  if (origin === null) return undefined;
  return origin.kind === "source"
    ? `Forked from “${sourceName(origin)}”`
    : `Forked from ${HIDDEN_SOURCE}`;
}

/** The text of the fork's own message holding entry `at`, shortened; null when not loaded. */
export function forkPointExcerpt(projection: Projection, at: string | null): string | null {
  if (at === null) return null;
  const node = projection.nodeOfEntry.get(at);
  const item = node === undefined ? undefined : projection.items.find((i) => i.message.id === node);
  if (!item) return null;
  const { content } = item.message;
  const raw =
    typeof content === "string"
      ? content
      : content
          .map((part) => (part.type === "text" ? part.text : ""))
          .join(" ")
          .trim();
  const text = raw.replace(/\s+/g, " ").trim();
  if (text === "") return null;
  return text.length > EXCERPT_MAX ? `${text.slice(0, EXCERPT_MAX - 1).trimEnd()}…` : text;
}
