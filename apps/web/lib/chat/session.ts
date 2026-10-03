/**
 * The chat for one team in one tab: the API bound to the team, and the open threads' controllers.
 * A controller lives while a view holds it (`acquire` / `release`); a thread created by the thread
 * list (`seed`) is ready before its view mounts, so the first message goes to the same controller.
 */
import type { ChatApi } from "./api";
import type { EventSourceFactory } from "./stream";
import { ThreadController } from "./thread-controller";
import type { ThreadSummary } from "./types";

export interface ChatSessionOptions {
  readonly teamId: string;
  readonly api: ChatApi;
  readonly eventSource?: EventSourceFactory | undefined;
  readonly newKey?: (() => string) | undefined;
  readonly reopenDelayMs?: ((attempt: number) => number) | undefined;
}

interface Held {
  readonly controller: ThreadController;
  count: number;
}

const TITLE_MAX = 80;

/** A thread's first title: the first line of its first message, shortened. */
export function titleFrom(text: string): string | undefined {
  const line =
    text
      .trim()
      .split(/\r?\n/u, 1)[0]
      ?.replace(/\p{Cc}/gu, "")
      .trim() ?? "";
  if (line === "") return undefined;
  return line.length > TITLE_MAX ? `${line.slice(0, TITLE_MAX - 1).trimEnd()}…` : line;
}

export class ChatSession {
  readonly teamId: string;
  readonly api: ChatApi;
  readonly #options: ChatSessionOptions;
  readonly #held = new Map<string, Held>();
  /** Title for the thread `initialize` creates next (taken from the message being sent). */
  #nextTitle: string | undefined;
  readonly #createdListeners = new Set<() => void>();

  constructor(options: ChatSessionOptions) {
    this.teamId = options.teamId;
    this.api = options.api;
    this.#options = options;
  }

  #create(threadId: string | null): ThreadController {
    return new ThreadController(threadId, {
      api: this.api,
      eventSource: this.#options.eventSource,
      ...(this.#options.newKey ? { newKey: this.#options.newKey } : {}),
      ...(this.#options.reopenDelayMs ? { reopenDelayMs: this.#options.reopenDelayMs } : {}),
    });
  }

  /** The controller for a thread (a fresh draft for `null`); call `release` when done. */
  acquire(threadId: string | null): ThreadController {
    if (threadId === null) return this.#create(null);
    const held = this.#held.get(threadId);
    if (held) {
      held.count += 1;
      return held.controller;
    }
    const controller = this.#create(threadId);
    this.#held.set(threadId, { controller, count: 1 });
    void controller.load();
    return controller;
  }

  release(threadId: string | null, controller: ThreadController): void {
    if (threadId === null) {
      controller.dispose();
      return;
    }
    const held = this.#held.get(threadId);
    if (!held || held.controller !== controller) return;
    held.count -= 1;
    if (held.count > 0) return;
    this.#held.delete(threadId);
    controller.dispose();
  }

  /** A thread just created by the thread list: ready (empty) and not read again on mount. */
  seed(summary: ThreadSummary): ThreadController {
    const existing = this.#held.get(summary.threadId);
    if (existing) return existing.controller;
    const controller = this.#create(summary.threadId);
    controller.seed(summary);
    this.#held.set(summary.threadId, { controller, count: 0 });
    return controller;
  }

  peek(threadId: string): ThreadController | undefined {
    return this.#held.get(threadId)?.controller;
  }

  setNextTitle(text: string): void {
    this.#nextTitle = titleFrom(text);
  }

  takeNextTitle(): string | undefined {
    const title = this.#nextTitle;
    this.#nextTitle = undefined;
    return title;
  }

  /** Called when a new thread got its first message (the thread list reads its title again). */
  onThreadCreated(listener: () => void): () => void {
    this.#createdListeners.add(listener);
    return () => this.#createdListeners.delete(listener);
  }

  threadCreated(): void {
    for (const listener of this.#createdListeners) listener();
  }

  dispose(): void {
    for (const held of this.#held.values()) held.controller.dispose();
    this.#held.clear();
  }
}
