import { z } from "zod";

/** One object in the external S3 bucket, as listed at backup time. */
export interface StoredObject {
  readonly key: string;
  readonly size: number;
  readonly etag: string;
}

/** Lists a bucket; the S3 implementation lives in s3.ts, tests use an in-memory one. */
export interface ObjectLister {
  /** Human-readable location for the manifest and messages (never credentials). */
  readonly location: {
    readonly endpoint: string;
    readonly bucket: string;
    readonly prefix: string;
  };
  list(): AsyncIterable<StoredObject>;
}

const objectSchema = z.object({
  key: z.string().min(1).max(1024),
  size: z.number().int().nonnegative(),
  etag: z.string().max(200),
});

export function serializeObjectList(objects: Iterable<StoredObject>): string {
  let out = "";
  for (const o of objects) out += `${JSON.stringify({ key: o.key, size: o.size, etag: o.etag })}\n`;
  return out;
}

export function parseObjectList(text: string): StoredObject[] {
  return text
    .split("\n")
    .map((line, i) => ({ line, n: i + 1 }))
    .filter(({ line }) => line.trim() !== "")
    .map(({ line, n }) => {
      let json: unknown;
      try {
        json = JSON.parse(line);
      } catch {
        throw new Error(`Invalid object list: line ${n} is not JSON`);
      }
      const parsed = objectSchema.safeParse(json);
      if (!parsed.success) throw new Error(`Invalid object list: line ${n} is not a valid object`);
      return parsed.data;
    });
}

export interface ObjectDiff {
  /** In the backup's list but not in the bucket. */
  readonly missing: readonly StoredObject[];
  readonly sizeMismatch: readonly { key: string; expected: number; actual: number }[];
  /** Same size, different ETag: content may differ (or a copy re-chunked a multipart upload). */
  readonly etagMismatch: readonly { key: string; expected: string; actual: string }[];
  /** In the bucket but not in the backup's list (written after the backup; harmless). */
  readonly extra: number;
}

export function compareObjects(
  expected: readonly StoredObject[],
  actual: Iterable<StoredObject>,
): ObjectDiff {
  const found = new Map<string, StoredObject>();
  for (const o of actual) found.set(o.key, o);
  const expectedKeys = new Set(expected.map((o) => o.key));
  const missing: StoredObject[] = [];
  const sizeMismatch: { key: string; expected: number; actual: number }[] = [];
  const etagMismatch: { key: string; expected: string; actual: string }[] = [];
  for (const want of expected) {
    const got = found.get(want.key);
    if (!got) missing.push(want);
    else if (got.size !== want.size) {
      sizeMismatch.push({ key: want.key, expected: want.size, actual: got.size });
    } else if (got.etag !== want.etag) {
      etagMismatch.push({ key: want.key, expected: want.etag, actual: got.etag });
    }
  }
  const extra = [...found.keys()].filter((k) => !expectedKeys.has(k)).length;
  return { missing, sizeMismatch, etagMismatch, extra };
}

/** Object keys referenced from the database that the listing does not contain. */
export function unlistedReferences(
  referenced: Iterable<string>,
  listing: readonly StoredObject[],
): string[] {
  const keys = new Set(listing.map((o) => o.key));
  return [...new Set(referenced)].filter((k) => !keys.has(k)).sort();
}

export async function collect(lister: ObjectLister): Promise<StoredObject[]> {
  const all: StoredObject[] = [];
  for await (const o of lister.list()) all.push(o);
  return all;
}
