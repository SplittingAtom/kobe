import type { Readable } from "node:stream";
import { logger } from "../logger.js";
import { threadKey, type BlobStore } from "../retention/blobs.js";

/** Why an offloaded body could not be read (logged with ids only, never content). */
export type OffloadedFailure =
  | "no_store"
  | "outside_thread"
  | "missing"
  | "too_large"
  | "unreadable"
  /** The read took longer than its caller allowed (a stalled store). */
  | "timed_out"
  /** The caller gave up (its request was aborted). */
  | "aborted";

export type OffloadedRead =
  | { readonly ok: true; readonly body: unknown }
  | { readonly ok: false; readonly reason: OffloadedFailure };

export interface OffloadedRef {
  readonly teamId: string;
  readonly threadId: string;
  /** For the log line; absent where the caller reads many (export). */
  readonly entryId?: string | undefined;
  /** Who is reading, for the log line ("export", "tool output"). */
  readonly reader: string;
}

/**
 * An offloaded entry body (D15) as JSON: only from the thread's own object tree (`threadKey`), so a
 * crafted reference can't reach another thread's, member's or team's objects; read with a byte cap
 * that holds even when the store understates the size. `signal` bounds the whole read, request and
 * body: an abort (a timeout, a request gone) cancels both. Failures are logged with the ids and
 * the error class only: a parse error's message quotes the body, which is tool output.
 */
export async function readOffloadedJson(
  blobs: BlobStore | undefined,
  ref: OffloadedRef,
  key: string,
  maxBytes: number,
  signal?: AbortSignal,
): Promise<OffloadedRead> {
  const fail = (reason: OffloadedFailure, err?: unknown): OffloadedRead => {
    const errorClass = err instanceof Error ? err.name : undefined;
    logger.warn(
      { teamId: ref.teamId, threadId: ref.threadId, entryId: ref.entryId, reason, errorClass },
      `${ref.reader}: offloaded entry body unreadable`,
    );
    return { ok: false, reason };
  };
  const stopped = () =>
    fail(
      signal?.reason instanceof Error && signal.reason.name === "TimeoutError"
        ? "timed_out"
        : "aborted",
    );
  if (!blobs) return fail("no_store");
  if (!threadKey(blobs.prefix, ref.teamId, ref.threadId, key)) return fail("outside_thread");
  if (signal?.aborted) return stopped();
  let body: Readable | undefined;
  const cancel = () => body?.destroy();
  signal?.addEventListener("abort", cancel, { once: true });
  try {
    const object = await blobs.objects.get(key, signal ? { signal } : {});
    if (signal?.aborted) {
      object?.body.destroy();
      return stopped();
    }
    if (!object) return fail("missing");
    body = object.body;
    if (object.size > maxBytes) {
      body.destroy();
      return fail("too_large");
    }
    const chunks: Buffer[] = [];
    let bytes = 0;
    for await (const chunk of body) {
      const b = Buffer.from(chunk as Uint8Array);
      bytes += b.length;
      if (bytes > maxBytes) {
        body.destroy();
        return fail("too_large");
      }
      chunks.push(b);
    }
    if (signal?.aborted) return stopped();
    return { ok: true, body: JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown };
  } catch (err) {
    return signal?.aborted ? stopped() : fail("unreadable", err);
  } finally {
    signal?.removeEventListener("abort", cancel);
  }
}
