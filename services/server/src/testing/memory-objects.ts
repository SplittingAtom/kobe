import { Readable } from "node:stream";
import type { ObjectStore } from "../workspace-sync/object-store.js";

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

  keys(prefix = ""): string[] {
    return [...this.objects.keys()].filter((k) => k.startsWith(prefix)).sort();
  }
}
