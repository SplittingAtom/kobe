/**
 * FakeKobe's `GET /v1/workspace/changes` (KOBE-496), as the server behaves: on each connect one
 * `file.state` per requested path from the fake workspace, then `file.changed` whenever a test
 * announces a change. Tests change `workspaceFiles` first, then call `announce` with who did it,
 * or call `move` (KOBE-516): it moves the files and says where each old path went (`moved_to`).
 */
import type { WorkspaceChangeActor, WorkspaceFileChange } from "@kobe/protocol";
import { sha256Hex } from "../../files/editor";
import type { EventSourceLike } from "../stream";

export class FakeWorkspaceChanges {
  readonly #files: Map<string, Uint8Array>;
  readonly #sources = new Set<FakeChangeSource>();
  /** Each path's last revision as the manifest would hold it (content, who, when). */
  readonly #revs = new Map<
    string,
    {
      rev: number;
      sha256: string | null;
      actor: WorkspaceChangeActor;
      at: string;
      movedTo?: string;
    }
  >();
  #head = 0;

  constructor(files: Map<string, Uint8Array>) {
    this.#files = files;
  }

  /** Open change streams and the paths each follows. */
  get open(): readonly (readonly string[])[] {
    return [...this.#sources].filter((s) => s.readyState === 1).map((s) => s.paths);
  }

  connect(url: URL): EventSourceLike {
    const source = new FakeChangeSource(this, url.searchParams.getAll("path"), () =>
      this.#sources.delete(source),
    );
    this.#sources.add(source);
    queueMicrotask(() => void source.connect());
    return source;
  }

  /** `path` changed in the fake workspace (already updated) by `actor`. */
  async announce(path: string, actor: WorkspaceChangeActor): Promise<void> {
    const bytes = this.#files.get(path);
    this.#head += 1;
    this.#revs.set(path, {
      rev: this.#head,
      sha256: bytes === undefined ? null : await sha256Hex(bytes),
      actor,
      at: new Date().toISOString(),
    });
    const change = await this.state(path);
    for (const source of [...this.#sources]) source.send("file.changed", change);
  }

  /**
   * A move of a file or folder by `actor` (the move route, another device, the agent's `mv`): the
   * files move in the fake workspace, then each old path's change names its new path.
   */
  async move(from: string, to: string, actor: WorkspaceChangeActor): Promise<void> {
    const moved = [...this.#files].filter(([p]) => p === from || p.startsWith(`${from}/`));
    for (const [p, bytes] of moved) {
      this.#files.delete(p);
      this.#files.set(`${to}${p.slice(from.length)}`, bytes);
    }
    for (const [p] of moved) {
      this.#head += 1;
      const movedTo = `${to}${p.slice(from.length)}`;
      const at = new Date().toISOString();
      this.#revs.set(p, { rev: this.#head, sha256: null, actor, at, movedTo });
      const change = await this.state(p);
      for (const source of [...this.#sources]) source.send("file.changed", change);
    }
  }

  /** Every open stream drops; the browser reconnects and gets each path's state again. */
  dropAll(): void {
    for (const source of [...this.#sources]) source.drop();
  }

  /** The path's row; content changed without an announcement is a new revision by the agent. */
  async state(path: string): Promise<WorkspaceFileChange> {
    const bytes = this.#files.get(path);
    const sha256 = bytes === undefined ? null : await sha256Hex(bytes);
    let meta = this.#revs.get(path);
    if (meta === undefined && sha256 === null) {
      return { path, sha256: null, rev: 0, actor: null, at: null };
    }
    if (meta?.sha256 !== sha256) {
      this.#head += 1;
      meta = {
        rev: this.#head,
        sha256,
        actor: { kind: "agent", name: null },
        at: new Date().toISOString(),
      };
      this.#revs.set(path, meta);
    }
    const moved = sha256 === null && meta.movedTo !== undefined ? { moved_to: meta.movedTo } : {};
    return { path, sha256, rev: meta.rev, actor: meta.actor, at: meta.at, ...moved };
  }
}

class FakeChangeSource implements EventSourceLike {
  readyState = 0;
  onopen: ((event: Event) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  readonly #listeners = new Map<string, ((event: MessageEvent<string>) => void)[]>();
  readonly #server: FakeWorkspaceChanges;
  readonly #onClose: () => void;
  readonly paths: readonly string[];

  constructor(server: FakeWorkspaceChanges, paths: readonly string[], onClose: () => void) {
    this.#server = server;
    this.paths = paths;
    this.#onClose = onClose;
  }

  addEventListener(type: string, listener: (event: MessageEvent<string>) => void): void {
    this.#listeners.set(type, [...(this.#listeners.get(type) ?? []), listener]);
  }

  close(): void {
    this.readyState = 2;
    this.#onClose();
  }

  async connect(): Promise<void> {
    if (this.readyState === 2) return;
    this.readyState = 1;
    this.onopen?.(new Event("open"));
    for (const path of this.paths) this.send("file.state", await this.#server.state(path));
  }

  send(type: "file.state" | "file.changed", change: WorkspaceFileChange): void {
    if (this.readyState !== 1 || !this.paths.includes(change.path)) return;
    const message = new MessageEvent<string>(type, { data: JSON.stringify(change) });
    for (const listener of this.#listeners.get(type) ?? []) listener(message);
  }

  drop(): void {
    if (this.readyState !== 1) return;
    this.readyState = 0;
    this.onerror?.(new Event("error"));
    setTimeout(() => void this.connect(), 0);
  }
}
