import { Readable } from "node:stream";
import type { ListOptions, ListPage, ObjectStore } from "../workspace-sync/object-store.js";

/**
 * In-memory {@link ObjectStore} for tests. Like S3 with a Content-Length, a put whose body errors
 * or ends short stores nothing.
 */
export class MemoryObjects implements ObjectStore {
  readonly objects = new Map<string, Buffer>();
  /** Keys deleted, in order (assertions). */
  readonly deleted: string[] = [];
  /** Make the next get of these keys report "no such object". */
  readonly lost = new Set<string>();

  async put(key: string, body: Readable, size: number): Promise<void> {
    const chunks: Buffer[] = [];
    for await (const chunk of body) chunks.push(Buffer.from(chunk as Uint8Array));
    const data = Buffer.concat(chunks);
    if (data.length !== size) throw new Error(`short body: ${data.length} of ${size} bytes`);
    this.objects.set(key, data);
  }

  async putStream(key: string, body: Readable): Promise<void> {
    const chunks: Buffer[] = [];
    for await (const chunk of body) chunks.push(Buffer.from(chunk as Uint8Array));
    this.objects.set(key, Buffer.concat(chunks));
  }

  get(key: string): Promise<{ body: Readable; size: number } | null> {
    const data = this.lost.has(key) ? undefined : this.objects.get(key);
    return Promise.resolve(data ? { body: Readable.from([data]), size: data.length } : null);
  }

  copy(from: string, to: string): Promise<void> {
    const data = this.objects.get(from);
    if (!data) return Promise.reject(new Error(`NoSuchKey: ${from}`));
    this.objects.set(to, Buffer.from(data));
    return Promise.resolve();
  }

  delete(keys: readonly string[]): Promise<void> {
    for (const k of keys) {
      this.objects.delete(k);
      this.deleted.push(k);
    }
    return Promise.resolve();
  }

  /** Last-modified times; a key without an entry counts as written now (tests backdate with `age`). */
  readonly modified = new Map<string, Date>();

  /** Pretends `key` was written `ms` ago. */
  age(key: string, ms: number): void {
    this.modified.set(key, new Date(Date.now() - ms));
  }

  list(prefix: string, options: ListOptions = {}): Promise<ListPage> {
    const limit = options.limit ?? 1000;
    const after = options.cursor ?? "";
    const delimiter = options.delimiter ?? "";
    const objects: { key: string; lastModified: Date }[] = [];
    const prefixes = new Set<string>();
    let last = "";
    let more = false;
    for (const key of [...this.objects.keys()].sort()) {
      if (!key.startsWith(prefix) || key <= after) continue;
      const rest = key.slice(prefix.length);
      const cut = delimiter ? rest.indexOf(delimiter) : -1;
      const folded = cut >= 0 ? prefix + rest.slice(0, cut + delimiter.length) : null;
      if (folded !== null && prefixes.has(folded)) continue;
      if (objects.length + prefixes.size >= limit) {
        more = true;
        break;
      }
      if (folded !== null) prefixes.add(folded);
      else objects.push({ key, lastModified: this.modified.get(key) ?? new Date() });
      last = folded ?? key;
    }
    // A folded prefix is resumed after all of its keys.
    const cursor = delimiter !== "" && last.endsWith(delimiter) ? `${last}\uffff` : last;
    return Promise.resolve({ objects, prefixes: [...prefixes], ...(more ? { next: cursor } : {}) });
  }

  keys(prefix = ""): string[] {
    return [...this.objects.keys()].filter((k) => k.startsWith(prefix)).sort();
  }
}
