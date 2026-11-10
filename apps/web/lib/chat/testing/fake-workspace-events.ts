/**
 * FakeKobe's `GET /v1/workspace/events` and `POST /v1/workspace/sync` (KOBE-599), as the server
 * behaves: each connect sends `workspace.state` with the current versions; `bump` moves one and
 * sends `workspace.changed` to every open stream. `syncs` counts Refreshes; `syncStatus` is what
 * the next ones answer, and `beforeSync` runs first (a test's sandbox push).
 */
import type { WorkspaceEvent, WorkspaceSyncStatus } from "@kobe/protocol";
import type { EventSourceLike } from "../stream";

export class FakeWorkspaceEvents {
  readonly #sources = new Set<FakeEventsSource>();
  #files = 0;
  #projects = 0;
  syncs = 0;
  syncStatus: WorkspaceSyncStatus = "synced";
  beforeSync: (() => void | Promise<void>) | undefined;
  /** Holds Refresh answers until it resolves (a busy state to look at). */
  syncGate: Promise<void> | undefined;

  get version(): WorkspaceEvent {
    return { files_rev: this.#files, projects_rev: `p${this.#projects}` };
  }

  /** Open event streams. */
  get open(): number {
    return [...this.#sources].filter((s) => s.readyState === 1).length;
  }

  connect(): EventSourceLike {
    const source = new FakeEventsSource(this, () => this.#sources.delete(source));
    this.#sources.add(source);
    queueMicrotask(() => source.connect());
    return source;
  }

  /** The member's files (a push, an upload) or the projects changed. */
  bump(what: "files" | "projects" = "files"): void {
    if (what === "files") this.#files += 1;
    else this.#projects += 1;
    for (const source of [...this.#sources]) source.send("workspace.changed", this.version);
  }

  async sync(): Promise<{ status: WorkspaceSyncStatus }> {
    this.syncs += 1;
    await this.syncGate;
    await this.beforeSync?.();
    return { status: this.syncStatus };
  }
}

class FakeEventsSource implements EventSourceLike {
  readyState = 0;
  onopen: ((event: Event) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  readonly #listeners = new Map<string, ((event: MessageEvent<string>) => void)[]>();
  readonly #server: FakeWorkspaceEvents;
  readonly #onClose: () => void;

  constructor(server: FakeWorkspaceEvents, onClose: () => void) {
    this.#server = server;
    this.#onClose = onClose;
  }

  addEventListener(type: string, listener: (event: MessageEvent<string>) => void): void {
    this.#listeners.set(type, [...(this.#listeners.get(type) ?? []), listener]);
  }

  close(): void {
    this.readyState = 2;
    this.#onClose();
  }

  connect(): void {
    if (this.readyState === 2) return;
    this.readyState = 1;
    this.onopen?.(new Event("open"));
    this.send("workspace.state", this.#server.version);
  }

  send(type: "workspace.state" | "workspace.changed", event: WorkspaceEvent): void {
    if (this.readyState !== 1) return;
    const message = new MessageEvent<string>(type, { data: JSON.stringify(event) });
    for (const listener of this.#listeners.get(type) ?? []) listener(message);
  }
}
