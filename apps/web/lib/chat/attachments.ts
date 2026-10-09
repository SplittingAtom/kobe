/**
 * The files attached to composer drafts (KOBE-145). A draft is keyed by its thread id (or "new").
 * Each file uploads as soon as it is added; the store keeps immutable snapshots so React can
 * subscribe with `useSyncExternalStore`. Sending takes the finished uploads' ids (`take`).
 */
import { precheck, type UploadFailure, type UploadTransport } from "./uploads";

export interface DraftFile {
  readonly id: string;
  readonly name: string;
  readonly size: number;
  readonly mimeType: string;
  readonly status: "uploading" | "done" | "error";
  /** 0..1 while uploading. */
  readonly progress: number;
  readonly fileId?: string | undefined;
  readonly error?: UploadFailure | undefined;
  /** Object URL of an image, for the thumbnail. */
  readonly previewUrl?: string | undefined;
}

export interface SentFile {
  readonly name: string;
  readonly size: number;
  readonly mimeType: string;
  readonly previewUrl?: string | undefined;
}

/** What a send carries: the upload ids for the server, the display info for the chips. */
export interface MessageFiles {
  readonly fileIds: readonly string[];
  readonly files: readonly SentFile[];
}

export const NEW_DRAFT = "new";
const EMPTY: readonly DraftFile[] = [];
const THUMBNAIL_MAX_BYTES = 10 * 1024 * 1024;

export interface AttachmentStoreOptions {
  readonly teamId: string;
  readonly transport: UploadTransport;
  readonly newId?: (() => string) | undefined;
}

export class AttachmentStore {
  readonly #options: AttachmentStoreOptions;
  readonly #drafts = new Map<string, readonly DraftFile[]>();
  readonly #files = new Map<string, File>();
  readonly #aborts = new Map<string, AbortController>();
  readonly #listeners = new Set<() => void>();
  readonly #sizes = new Map<string, number>();
  #n = 0;

  constructor(options: AttachmentStoreOptions) {
    this.#options = options;
  }

  readonly subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  };

  get = (draft: string): readonly DraftFile[] => this.#drafts.get(draft) ?? EMPTY;

  /** The size of a file sent earlier in this tab, for the chips of committed messages. */
  sizeOf(name: string): number | undefined {
    return this.#sizes.get(name);
  }

  #update(draft: string, fn: (files: readonly DraftFile[]) => readonly DraftFile[]): void {
    this.#drafts.set(draft, fn(this.get(draft)));
    for (const listener of this.#listeners) listener();
  }

  #patch(draft: string, id: string, patch: Partial<DraftFile>): void {
    this.#update(draft, (files) => files.map((f) => (f.id === id ? { ...f, ...patch } : f)));
  }

  /** Adds files to a draft and starts uploading each. Too-large files are listed with their error. */
  add(draft: string, files: readonly File[], threadId?: string): void {
    for (const file of files) {
      const id = this.#options.newId?.() ?? `att-${(this.#n += 1)}`;
      const held = this.get(draft).filter((f) => f.status !== "error");
      const refusal = precheck(file, held);
      const previewUrl = refusal ? undefined : previewOf(file);
      const entry: DraftFile = {
        id,
        name: file.name,
        size: file.size,
        mimeType: file.type || "application/octet-stream",
        status: refusal ? "error" : "uploading",
        progress: 0,
        error: refusal,
        previewUrl,
      };
      this.#update(draft, (list) => [...list, entry]);
      if (!refusal) this.#start(draft, id, file, threadId);
    }
  }

  #start(draft: string, id: string, file: File, threadId?: string): void {
    const abort = new AbortController();
    this.#files.set(id, file);
    this.#aborts.set(id, abort);
    void this.#options
      .transport({
        teamId: this.#options.teamId,
        file,
        threadId,
        signal: abort.signal,
        onProgress: (progress) => this.#patch(draft, id, { progress }),
      })
      .then((outcome) => {
        this.#aborts.delete(id);
        if (abort.signal.aborted) return;
        if (outcome.ok) {
          this.#patch(draft, id, { status: "done", progress: 1, fileId: outcome.file.fileId });
        } else this.#patch(draft, id, { status: "error", error: outcome.error });
      });
  }

  retry(draft: string, id: string, threadId?: string): void {
    const file = this.#files.get(id);
    if (!file) return;
    this.#patch(draft, id, { status: "uploading", progress: 0, error: undefined });
    this.#start(draft, id, file, threadId);
  }

  remove(draft: string, id: string): void {
    this.#aborts.get(id)?.abort();
    this.#aborts.delete(id);
    this.#files.delete(id);
    const gone = this.get(draft).find((f) => f.id === id);
    if (gone?.previewUrl) URL.revokeObjectURL(gone.previewUrl);
    this.#update(draft, (files) => files.filter((f) => f.id !== id));
  }

  /** Why the draft can't be sent yet, or undefined when it can. */
  blocker(draft: string): string | undefined {
    const files = this.get(draft);
    if (files.some((f) => f.status === "uploading"))
      return "Wait for the files to finish uploading.";
    if (files.some((f) => f.status === "error")) {
      return "Remove the files that failed, or retry them, before sending.";
    }
    return undefined;
  }

  /** The finished uploads for sending; the draft is emptied by `sent`, once the server accepted. */
  ready(draft: string): MessageFiles {
    const done = this.get(draft).filter((f) => f.status === "done" && f.fileId !== undefined);
    return {
      fileIds: done.map((f) => f.fileId as string),
      files: done.map(({ name, size, mimeType, previewUrl }) => ({
        name,
        size,
        mimeType,
        previewUrl,
      })),
    };
  }

  /** The message was accepted: the draft's files now belong to it. */
  sent(draft: string): void {
    for (const f of this.get(draft)) {
      this.#sizes.set(f.name, f.size);
      this.#files.delete(f.id);
    }
    this.#update(draft, () => EMPTY);
  }

  dispose(): void {
    for (const abort of this.#aborts.values()) abort.abort();
    this.#aborts.clear();
  }
}

function previewOf(file: File): string | undefined {
  if (!file.type.startsWith("image/") || file.size > THUMBNAIL_MAX_BYTES) return undefined;
  return typeof URL.createObjectURL === "function" ? URL.createObjectURL(file) : undefined;
}
