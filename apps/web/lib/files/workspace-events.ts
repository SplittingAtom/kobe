/**
 * The Files panel keeping itself current (KOBE-599): one EventSource on
 * `GET /v1/workspace/events` (protocol `workspace-events.ts`) while at least one listener is
 * subscribed. The server says when the member's own workspace manifest (`files_rev`) or the
 * workspace's projects and the member's checkouts (`projects_rev`) moved; listeners hear which,
 * debounced, so a burst of pushes lists once. Every (re)connect starts with the current versions
 * (`workspace.state`): one that differs from the last heard is a change too (the catch-up after a
 * drop or sleep). A stream the server ended or refused is opened again after a bounded backoff,
 * unless `probe` says the page's team is no longer the active one: then it stops.
 */
import { WORKSPACE_EVENT_TYPES, workspaceEventSchema, type WorkspaceEvent } from "@kobe/protocol";
import "../security/zod-jitless";
import {
  browserEventSource,
  CLOSED,
  type EventSourceFactory,
  type EventSourceLike,
} from "../chat/stream";

/** What moved since the listeners last heard. */
export interface WorkspaceMoved {
  readonly files: boolean;
  readonly projects: boolean;
}

/** Waits after a change before telling listeners, so a burst is heard once (ms). */
export const EVENTS_DEBOUNCE_MS = 400;
export const EVENTS_REOPEN_DELAYS_MS: readonly number[] = [5_000, 15_000, 30_000, 60_000];

export function workspaceEventsUrl(teamId: string): string {
  return `/v1/workspace/events?${new URLSearchParams({ team: teamId }).toString()}`;
}

export interface WorkspaceEventFeedOptions {
  readonly teamId: string;
  readonly eventSource?: EventSourceFactory | undefined;
  readonly debounceMs?: number;
  readonly reopenDelaysMs?: readonly number[];
  /** Before re-opening a stream the server ended: false stops the feed (team changed). */
  readonly probe?: (() => Promise<boolean>) | undefined;
}

export class WorkspaceEventFeed {
  readonly #teamId: string;
  readonly #factory: EventSourceFactory;
  readonly #debounceMs: number;
  readonly #reopenDelays: readonly number[];
  readonly #probe: (() => Promise<boolean>) | undefined;
  readonly #listeners = new Set<(moved: WorkspaceMoved) => void>();
  #source: EventSourceLike | undefined;
  #last: WorkspaceEvent | undefined;
  #pending: { files: boolean; projects: boolean } | undefined;
  #notifyTimer: ReturnType<typeof setTimeout> | undefined;
  #reopenTimer: ReturnType<typeof setTimeout> | undefined;
  #attempt = 0;
  #stopped = false;
  #disposed = false;

  constructor(options: WorkspaceEventFeedOptions) {
    this.#teamId = options.teamId;
    this.#factory = options.eventSource ?? browserEventSource;
    this.#debounceMs = options.debounceMs ?? EVENTS_DEBOUNCE_MS;
    this.#reopenDelays = options.reopenDelaysMs ?? EVENTS_REOPEN_DELAYS_MS;
    this.#probe = options.probe;
  }

  /** Hears what moved; the stream is open while anyone listens. */
  subscribe(listener: (moved: WorkspaceMoved) => void): () => void {
    this.#listeners.add(listener);
    if (this.#source === undefined && this.#reopenTimer === undefined) this.#open();
    return () => {
      this.#listeners.delete(listener);
      if (this.#listeners.size > 0) return;
      this.#close();
      // A panel that comes back lists by itself; only changes after that count.
      this.#last = undefined;
    };
  }

  /** Whether a stream is open (tests). */
  get streaming(): boolean {
    return this.#source !== undefined;
  }

  get stopped(): boolean {
    return this.#stopped;
  }

  dispose(): void {
    this.#disposed = true;
    this.#listeners.clear();
    this.#close();
  }

  #open(): void {
    if (this.#disposed || this.#stopped || this.#listeners.size === 0) return;
    const source = this.#factory(workspaceEventsUrl(this.#teamId));
    this.#source = source;
    const onMessage = (message: MessageEvent<string>) => {
      if (this.#source !== source) return;
      let raw: unknown;
      try {
        raw = JSON.parse(message.data);
      } catch {
        return;
      }
      const parsed = workspaceEventSchema.safeParse(raw);
      if (!parsed.success) return;
      this.#attempt = 0;
      this.#heard(parsed.data);
    };
    for (const type of WORKSPACE_EVENT_TYPES) source.addEventListener(type, onMessage);
    source.onerror = () => {
      if (this.#source !== source || source.readyState !== CLOSED) return;
      // Ended or refused by the server (a network drop the browser retries itself).
      this.#source = undefined;
      source.close();
      const delay =
        this.#reopenDelays[Math.min(this.#attempt, this.#reopenDelays.length - 1)] ?? 60_000;
      this.#attempt += 1;
      const probe = this.#probe;
      if (!probe) return this.#scheduleReopen(delay);
      void probe().then(
        (retry) => (retry ? this.#scheduleReopen(delay) : this.#stop()),
        () => this.#scheduleReopen(delay),
      );
    };
  }

  #heard(now: WorkspaceEvent): void {
    const last = this.#last;
    this.#last = now;
    // The first state is what the panel just listed itself.
    if (last === undefined) return;
    const files = last.files_rev !== now.files_rev;
    const projects = last.projects_rev !== now.projects_rev;
    if (!files && !projects) return;
    this.#pending = {
      files: files || (this.#pending?.files ?? false),
      projects: projects || (this.#pending?.projects ?? false),
    };
    if (this.#notifyTimer !== undefined) return;
    this.#notifyTimer = setTimeout(() => {
      this.#notifyTimer = undefined;
      const moved = this.#pending;
      this.#pending = undefined;
      if (moved === undefined) return;
      for (const listener of [...this.#listeners]) listener(moved);
    }, this.#debounceMs);
  }

  #scheduleReopen(ms: number): void {
    if (this.#disposed || this.#stopped || this.#listeners.size === 0) return;
    this.#reopenTimer = setTimeout(() => {
      this.#reopenTimer = undefined;
      this.#open();
    }, ms);
  }

  #stop(): void {
    this.#stopped = true;
    this.#close();
  }

  #close(): void {
    if (this.#reopenTimer !== undefined) clearTimeout(this.#reopenTimer);
    this.#reopenTimer = undefined;
    if (this.#notifyTimer !== undefined) clearTimeout(this.#notifyTimer);
    this.#notifyTimer = undefined;
    this.#pending = undefined;
    const source = this.#source;
    this.#source = undefined;
    source?.close();
  }
}
