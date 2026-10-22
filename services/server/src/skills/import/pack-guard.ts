import { inflateSync } from "node:zlib";
import type { GitHttpRequest, GitHttpResponse, HttpClient } from "isomorphic-git";
import { ImportError } from "./fetch.js";

/**
 * Bounds what a fetched git pack expands to (KOBE-344 review): isomorphic-git inflates and
 * resolves every object of a pack in memory while indexing it, so a small pack of highly
 * compressible blobs, or deltas that copy the same bytes over and over, could grow to gigabytes
 * in the shared server. Before isomorphic-git sees an upload-pack answer, this walks the pack:
 * every object's inflated size (and a delta's result size, from its header) must stay within
 * `maxObjectBytes`, and all of them together within `maxTotalBytes`. Inflation itself is capped
 * at the object's declared size, so the walk never expands more than the caps allow.
 */
export interface PackCaps {
  readonly maxObjectBytes: number;
  readonly maxTotalBytes: number;
}

const OBJ_OFS_DELTA = 6;
const OBJ_REF_DELTA = 7;

function tooLarge(what: string): ImportError {
  return new ImportError("too_large", `The repository is too large to import (${what}).`);
}

/** The pack carried by an upload-pack answer: side-band 1 data, or the raw bytes after NAK/ACK. */
export function packOf(body: Uint8Array): Uint8Array | null {
  const buf = Buffer.from(body.buffer, body.byteOffset, body.byteLength);
  const parts: Buffer[] = [];
  let pos = 0;
  while (pos + 4 <= buf.length) {
    if (buf.subarray(pos, pos + 4).toString("latin1") === "PACK") return buf.subarray(pos);
    const len = Number.parseInt(buf.subarray(pos, pos + 4).toString("latin1"), 16);
    if (!Number.isFinite(len)) return null;
    if (len === 0) {
      pos += 4;
      continue;
    }
    if (len < 4 || pos + len > buf.length) return null;
    const payload = buf.subarray(pos + 4, pos + len);
    if (payload[0] === 1) parts.push(payload.subarray(1));
    pos += len;
  }
  return parts.length > 0 ? Buffer.concat(parts) : null;
}

function varint(buf: Buffer, pos: number): { value: number; next: number } {
  let value = 0;
  let shift = 0;
  let p = pos;
  for (;;) {
    const b = buf[p];
    if (b === undefined)
      throw new ImportError("fetch_failed", "The repository sent a broken pack.");
    value += (b & 0x7f) * 2 ** shift;
    shift += 7;
    p += 1;
    if ((b & 0x80) === 0) return { value, next: p };
  }
}

/** Throws ImportError("too_large") when the pack would expand beyond `caps`. */
export function checkPack(pack: Uint8Array, caps: PackCaps): void {
  const buf = Buffer.from(pack.buffer, pack.byteOffset, pack.byteLength);
  if (buf.length < 12 || buf.subarray(0, 4).toString("latin1") !== "PACK")
    throw new ImportError("fetch_failed", "The repository sent a broken pack.");
  const count = buf.readUInt32BE(8);
  let pos = 12;
  let total = 0;
  for (let i = 0; i < count; i++) {
    let b = buf[pos];
    if (b === undefined)
      throw new ImportError("fetch_failed", "The repository sent a broken pack.");
    const type = (b >> 4) & 7;
    let size = b & 0x0f;
    let shift = 4;
    pos += 1;
    while (b & 0x80) {
      b = buf[pos];
      if (b === undefined)
        throw new ImportError("fetch_failed", "The repository sent a broken pack.");
      size += (b & 0x7f) * 2 ** shift;
      shift += 7;
      pos += 1;
    }
    if (type === OBJ_OFS_DELTA) pos = varint(buf, pos).next;
    else if (type === OBJ_REF_DELTA) pos += 20;
    if (size > caps.maxObjectBytes) throw tooLarge("an object is over the per-file limit");
    let inflated: Buffer;
    let consumed: number;
    try {
      const out = inflateSync(buf.subarray(pos), {
        info: true,
        maxOutputLength: Math.max(1, size),
      }) as unknown as { buffer: Buffer; engine: { bytesWritten: number } };
      inflated = out.buffer;
      consumed = out.engine.bytesWritten;
    } catch {
      throw tooLarge("an object expands beyond its declared size");
    }
    if (inflated.length !== size)
      throw new ImportError("fetch_failed", "The repository sent a broken pack.");
    let result = size;
    if (type === OBJ_OFS_DELTA || type === OBJ_REF_DELTA) {
      const base = varint(inflated, 0);
      result = varint(inflated, base.next).value;
      if (result > caps.maxObjectBytes) throw tooLarge("a delta is over the per-file limit");
    }
    total += result;
    if (total > caps.maxTotalBytes) throw tooLarge("all objects together are over the limit");
    pos += consumed;
  }
}

/** An HTTP client whose upload-pack answers are checked by {@link checkPack} first. */
export function guardPacks(http: HttpClient, caps: PackCaps): HttpClient {
  return {
    async request(req: GitHttpRequest): Promise<GitHttpResponse> {
      const res = await http.request(req);
      if (!req.url.endsWith("/git-upload-pack") || res.statusCode !== 200) return res;
      const chunks: Uint8Array[] = [];
      for await (const c of res.body ?? []) chunks.push(c);
      const body = new Uint8Array(Buffer.concat(chunks));
      const pack = packOf(body);
      if (pack) checkPack(pack, caps);
      return {
        ...res,
        body: (async function* () {
          yield body;
        })(),
      };
    },
  };
}
