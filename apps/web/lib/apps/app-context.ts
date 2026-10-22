import { APP_CONTEXT_MAX_BYTES, imitatesAppContext } from "@kobe/protocol";

export { splitAppContext, type SentAppContext } from "@kobe/protocol";
import { MESSAGE_TEXT_MAX } from "./host-bridge";

/**
 * What MCP Apps put in front of the member (KOBE-439, spec §8, T8): `ui/message` text inserted at
 * the composer's caret (never sent), and `ui/update-model-context` as a visible, removable chip
 * per app, sent with the member's next message in that thread. Nothing reaches the model without
 * the member's send.
 */

/** One app's latest context in one thread's draft (last write wins per app). */
export interface AppContextChip {
  readonly appId: string;
  readonly connectorId: string;
  readonly templateSha256: string;
  /** The app's title, for "Context from …". */
  readonly title: string;
  readonly data: {
    readonly content?: readonly Record<string, unknown>[];
    readonly structuredContent?: Record<string, unknown>;
  };
}

/** The chip's one line: the first text block, else the structured content, shortened. */
export function chipSummary(chip: AppContextChip): string {
  const text = chip.data.content?.find(
    (b) => b["type"] === "text" && typeof b["text"] === "string",
  );
  const raw =
    (text?.["text"] as string | undefined) ?? JSON.stringify(chip.data.structuredContent ?? {});
  // Invisible and bidi characters could make the line read differently (review LOW-I).
  const line = raw
    .replace(/[\p{Cf}\p{Zl}\p{Zp}]/gu, "")
    .replace(/\s+/g, " ")
    .trim();
  return line.length > 80 ? `${line.slice(0, 79)}…` : line;
}

const bytes = (value: unknown) => new TextEncoder().encode(JSON.stringify(value)).length;

type Listener = () => void;
const NO_CHIPS: ReadonlyMap<string, AppContextChip> = new Map();

/** Chips per composer draft (the thread id), observable. Every change makes new maps. */
export class AppContextStore {
  #byDraft = new Map<string, ReadonlyMap<string, AppContextChip>>();
  #listeners: readonly Listener[] = [];

  subscribe = (listener: Listener): (() => void) => {
    this.#listeners = [...this.#listeners, listener];
    return () => {
      this.#listeners = this.#listeners.filter((l) => l !== listener);
    };
  };

  #emit() {
    for (const l of this.#listeners) l();
  }

  /** A context over 8 KiB is refused (the app gets an error). */
  set(draft: string, chip: AppContextChip): boolean {
    if (bytes(chip.data) > APP_CONTEXT_MAX_BYTES) return false;
    const next = new Map(this.#byDraft.get(draft) ?? []);
    next.set(chip.appId, chip);
    this.#byDraft = new Map(this.#byDraft).set(draft, next);
    this.#emit();
    return true;
  }

  remove(draft: string, appId: string): void {
    const current = this.#byDraft.get(draft);
    if (!current?.has(appId)) return;
    const next = new Map(current);
    next.delete(appId);
    this.#byDraft = new Map(this.#byDraft).set(draft, next);
    this.#emit();
  }

  /** After a send (KOBE-415): drops the chips that went; a chip an app set meanwhile stays. */
  removeSent(draft: string, sent: readonly AppContextChip[]): void {
    const current = this.#byDraft.get(draft);
    if (!current) return;
    const next = new Map([...current].filter(([, chip]) => !sent.includes(chip)));
    if (next.size === current.size) return;
    this.#byDraft = new Map(this.#byDraft).set(draft, next);
    this.#emit();
  }

  clear(draft: string): void {
    if (!this.#byDraft.has(draft)) return;
    const next = new Map(this.#byDraft);
    next.delete(draft);
    this.#byDraft = next;
    this.#emit();
  }

  /** A stable snapshot (the same map until the draft's chips change), for useSyncExternalStore. */
  snapshot(draft: string): ReadonlyMap<string, AppContextChip> {
    return this.#byDraft.get(draft) ?? NO_CHIPS;
  }

  forDraft(draft: string): readonly AppContextChip[] {
    return [...(this.#byDraft.get(draft)?.values() ?? [])];
  }
}

/** The message body's `app_context` for the chips shown. */
export function appContextBody(chips: readonly AppContextChip[]) {
  return chips.map((c) => ({
    connector_id: c.connectorId,
    app_id: c.appId,
    template_sha256: c.templateSha256,
    data: c.data,
  }));
}

/**
 * `ui/message` text for the composer of one thread (review LOW-H: the card's own thread, never
 * whichever composer mounted last), with the app's name for the "From …" marker. Text that
 * imitates app context, or over 4 KiB, is refused.
 */
export class ComposerInsertChannel {
  #listeners = new Map<string, readonly ((text: string, from: string) => boolean)[]>();

  listen(threadId: string, listener: (text: string, from: string) => boolean): () => void {
    const own = (text: string, from: string) => listener(text, from);
    this.#listeners.set(threadId, [...(this.#listeners.get(threadId) ?? []), own]);
    return () => {
      const left = (this.#listeners.get(threadId) ?? []).filter((l) => l !== own);
      if (left.length === 0) this.#listeners.delete(threadId);
      else this.#listeners.set(threadId, left);
    };
  }

  request(threadId: string, text: string, from: string): boolean {
    if (new TextEncoder().encode(text).length > MESSAGE_TEXT_MAX) return false;
    if (imitatesAppContext(text)) return false;
    return this.#listeners.get(threadId)?.at(-1)?.(text, from) ?? false;
  }
}

/** `text` with `insert` at `caret`, and the caret after it. */
export function insertAt(text: string, caret: number, insert: string) {
  const at = Math.max(0, Math.min(caret, text.length));
  return { text: text.slice(0, at) + insert + text.slice(at), caret: at + insert.length };
}
