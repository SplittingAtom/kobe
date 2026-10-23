/**
 * The file editor's state shared across the artifact column (KOBE-463), held by the chat session
 * so it survives a tab or thread switch: unsaved drafts per file (the column warns before one is
 * lost) and the agent's proposals under review. Immutable snapshots, so `useSyncExternalStore`
 * readers re-render only on a change.
 */
import type { FileEditProposedPayload } from "@kobe/protocol";

type Listener = () => void;

class Snapshots<T> {
  #value: ReadonlyMap<string, T> = new Map();
  #listeners: readonly Listener[] = [];

  subscribe = (listener: Listener): (() => void) => {
    this.#listeners = [...this.#listeners, listener];
    return () => {
      this.#listeners = this.#listeners.filter((l) => l !== listener);
    };
  };

  protected get map(): ReadonlyMap<string, T> {
    return this.#value;
  }

  protected replace(next: ReadonlyMap<string, T>): void {
    this.#value = next;
    for (const l of this.#listeners) l();
  }

  protected without(key: string): void {
    if (!this.#value.has(key)) return;
    const next = new Map(this.#value);
    next.delete(key);
    this.replace(next);
  }
}

/** Text the member typed and has not saved, with the version it was based on. */
export interface EditDraft {
  readonly text: string;
  readonly baseSha256: string;
}

export class EditDraftStore extends Snapshots<EditDraft> {
  get(path: string): EditDraft | undefined {
    return this.map.get(path);
  }

  set(path: string, draft: EditDraft): void {
    const old = this.map.get(path);
    if (old?.text === draft.text && old.baseSha256 === draft.baseSha256) return;
    this.replace(new Map(this.map).set(path, draft));
  }

  clear(path: string): void {
    this.without(path);
  }

  hasAny(): boolean {
    return this.map.size > 0;
  }

  /** A file or folder moved (`from` -> `to`): its drafts follow. */
  move(from: string, to: string): void {
    const rename = (path: string) =>
      path === from ? to : path.startsWith(`${from}/`) ? `${to}${path.slice(from.length)}` : path;
    if (![...this.map.keys()].some((path) => rename(path) !== path)) return;
    this.replace(new Map([...this.map].map(([path, draft]) => [rename(path), draft])));
  }
}

/** A `propose_file_edit` proposal (the event payload or a list row), in web casing. */
export interface ProposalView {
  readonly toolCallId: string;
  readonly path: string;
  readonly baseSha256: string;
  readonly content: string;
  readonly summary: string;
}

export function proposalFromEvent(payload: FileEditProposedPayload): ProposalView {
  return {
    toolCallId: payload.tool_call_id,
    path: payload.path,
    baseSha256: payload.base_sha256,
    content: payload.content,
    summary: payload.summary,
  };
}

export type ReviewOutcome = "committed" | "discarded";

/** The proposal under review per file (at most one), and how reviews ended, per tool call. */
export class FileReviewStore extends Snapshots<ProposalView> {
  #outcomes: ReadonlyMap<string, ReviewOutcome> = new Map();

  reviewOf(path: string): ProposalView | undefined {
    return this.map.get(path);
  }

  outcomeOf(toolCallId: string): ReviewOutcome | undefined {
    return this.#outcomes.get(toolCallId);
  }

  /** Review starts (the card's Review): it replaces a review of the same file. */
  start(proposal: ProposalView): void {
    if (this.map.get(proposal.path) === proposal) return;
    this.replace(new Map(this.map).set(proposal.path, proposal));
  }

  finish(path: string, outcome: ReviewOutcome): void {
    const review = this.map.get(path);
    if (!review) return;
    this.#outcomes = new Map(this.#outcomes).set(review.toolCallId, outcome);
    const next = new Map(this.map);
    next.delete(path);
    this.replace(next);
  }
}

/**
 * What auto-open did with a live proposal: started its review, held back over unsaved edits, or
 * skipped it (the switch was off when it arrived; turning it on later never opens it).
 */
export type AutoOpenOutcome = "opened" | "held" | "skipped";

/**
 * The member's "Open edits automatically" switch (KOBE-489) as flipped on this page, shared by
 * every proposal card (until flipped, the stored preference applies). It also remembers the live proposals already acted on (by
 * `<run>:<tool call>`), so a remounted card never reopens one.
 */
export class AutoOpenEditsStore {
  #chosen: boolean | undefined;
  #listeners: readonly Listener[] = [];
  #handled: ReadonlyMap<string, AutoOpenOutcome> = new Map();

  outcomeOf(key: string): AutoOpenOutcome | undefined {
    return this.#handled.get(key);
  }

  /** Records what auto-open did with the proposal under `key` (once: the first answer stays). */
  record(key: string, outcome: AutoOpenOutcome): void {
    if (this.#handled.has(key)) return;
    this.#handled = new Map(this.#handled).set(key, outcome);
  }

  subscribe = (listener: Listener): (() => void) => {
    this.#listeners = [...this.#listeners, listener];
    return () => {
      this.#listeners = this.#listeners.filter((l) => l !== listener);
    };
  };

  /** The member's choice on this page; undefined until they flip the switch. */
  chosen = (): boolean | undefined => this.#chosen;

  /** The member flips the switch. */
  set(on: boolean): void {
    if (this.#chosen === on) return;
    this.#chosen = on;
    this.#notify();
  }

  #notify(): void {
    for (const l of this.#listeners) l();
  }
}
