/**
 * Size and thumbnail for the chips of sent messages after a reload (KOBE-194). A committed user
 * message only carries Pi's "Attached files:" text, so the data comes from the caller's workspace
 * (`uploads/<thread>/`, the same files API as the file browser): one listing per folder, shared by
 * every chip in it, and, for small raster images, the bytes fetched with the session's credentials
 * and shown through a blob URL typed from an allowlist (no data URLs, never SVG).
 */
import type { FileEntry, FilesApi } from "../files/api";

export interface SentFileInfo {
  readonly size?: number | undefined;
  readonly previewUrl?: string | undefined;
}

export const THUMBNAIL_TYPES: ReadonlySet<string> = new Set([
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
]);
const THUMBNAIL_MAX_BYTES = 5 * 1024 * 1024;
const UPLOADS_PREFIX = "/workspace/uploads/";
const MAX_PAGES = 10;

/** The workspace path of a sandbox upload path, or undefined for anything else. */
export function uploadPathOf(sandboxPath: string): string | undefined {
  if (!sandboxPath.startsWith(UPLOADS_PREFIX) || sandboxPath.split("/").includes("..")) {
    return undefined;
  }
  return sandboxPath.slice("/workspace/".length);
}

export class SentFileCache {
  readonly #api: FilesApi;
  readonly #folders = new Map<string, Promise<ReadonlyMap<string, FileEntry> | undefined>>();
  readonly #thumbs = new Map<string, Promise<string | undefined>>();
  readonly #urls = new Set<string>();

  constructor(api: FilesApi) {
    this.#api = api;
  }

  async #list(folder: string): Promise<ReadonlyMap<string, FileEntry> | undefined> {
    const entries = new Map<string, FileEntry>();
    let cursor: string | undefined;
    for (let page = 0; page < MAX_PAGES; page += 1) {
      const res = await this.#api.list(folder, cursor);
      if (!res.ok) return undefined;
      for (const e of res.data.entries) entries.set(e.path, e);
      if (!res.data.nextCursor) break;
      cursor = res.data.nextCursor;
    }
    return entries;
  }

  #folder(folder: string): Promise<ReadonlyMap<string, FileEntry> | undefined> {
    const known = this.#folders.get(folder);
    if (known) return known;
    const listing = this.#list(folder).then((found) => {
      if (!found) this.#folders.delete(folder); // a failure is retried on the next look
      return found;
    });
    this.#folders.set(folder, listing);
    return listing;
  }

  #thumb(path: string, mimeType: string): Promise<string | undefined> {
    const known = this.#thumbs.get(path);
    if (known) return known;
    const made = this.#api.download(path).then((res) => {
      if (!res.ok) {
        this.#thumbs.delete(path);
        return undefined;
      }
      const url = URL.createObjectURL(new Blob([new Uint8Array(res.data)], { type: mimeType }));
      this.#urls.add(url);
      return url;
    });
    this.#thumbs.set(path, made);
    return made;
  }

  /** Size (and a thumbnail for small raster images) of an upload; empty when it can't be found. */
  async info(sandboxPath: string, mimeType: string): Promise<SentFileInfo> {
    const path = uploadPathOf(sandboxPath);
    if (path === undefined) return {};
    const folder = await this.#folder(path.slice(0, path.lastIndexOf("/")));
    const entry = folder?.get(path);
    if (!entry || entry.sizeBytes === null) return {};
    const showable = THUMBNAIL_TYPES.has(mimeType) && entry.sizeBytes <= THUMBNAIL_MAX_BYTES;
    return {
      size: entry.sizeBytes,
      previewUrl: showable ? await this.#thumb(path, mimeType) : undefined,
    };
  }

  dispose(): void {
    for (const url of this.#urls) URL.revokeObjectURL(url);
    this.#urls.clear();
    this.#thumbs.clear();
    this.#folders.clear();
  }
}
