import { APP_CONTEXT_MAX_BYTES, APP_CONTEXT_PREAMBLE } from "@kobe/protocol";
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
  const line = raw.replace(/\s+/g, " ").trim();
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

/** `ui/message` text into the composer on screen; false when there is none to take it. */
export class ComposerInsertChannel {
  #listeners: readonly ((text: string) => boolean)[] = [];

  listen(listener: (text: string) => boolean): () => void {
    const own = (text: string) => listener(text);
    this.#listeners = [...this.#listeners, own];
    return () => {
      this.#listeners = this.#listeners.filter((l) => l !== own);
    };
  }

  request(text: string): boolean {
    if (new TextEncoder().encode(text).length > MESSAGE_TEXT_MAX) return false;
    return this.#listeners.at(-1)?.(text) ?? false;
  }
}

/** `text` with `insert` at `caret`, and the caret after it. */
export function insertAt(text: string, caret: number, insert: string) {
  const at = Math.max(0, Math.min(caret, text.length));
  return { text: text.slice(0, at) + insert + text.slice(at), caret: at + insert.length };
}

export interface SentAppContext {
  /** The connector name from the block's `source`. */
  readonly source: string;
  /** The block's JSON as sent (pretty-printed). */
  readonly json: string;
}

const BLOCK =
  /^<app-context source="connector:([^"]*)" untrusted="true">\n([\s\S]*?)\n<\/app-context>/;

/**
 * A sent message whose text starts with the server's preamble and fenced blocks: the blocks (for
 * chips in history) and the member's own text. Anything else is the text as it is.
 */
export function splitAppContext(text: string): {
  readonly contexts: readonly SentAppContext[];
  readonly rest: string;
} {
  if (!text.startsWith(`${APP_CONTEXT_PREAMBLE}\n`)) return { contexts: [], rest: text };
  let at = APP_CONTEXT_PREAMBLE.length + 1;
  const contexts: SentAppContext[] = [];
  for (;;) {
    const match = BLOCK.exec(text.slice(at));
    if (!match) break;
    contexts.push({ source: match[1] ?? "", json: match[2] ?? "" });
    at += match[0].length;
    if (text.startsWith("\n\n", at)) return { contexts, rest: text.slice(at + 2) };
    if (!text.startsWith("\n", at)) break;
    at += 1;
  }
  return contexts.length === 0 ? { contexts: [], rest: text } : { contexts, rest: text.slice(at) };
}
