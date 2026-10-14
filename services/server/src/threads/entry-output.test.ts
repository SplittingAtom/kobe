import { randomUUID } from "node:crypto";
import { Readable } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import type { BlobStore } from "../retention/blobs.js";
import type { ObjectStore } from "../workspace-sync/object-store.js";
import {
  OUTPUT_INLINE_MAX_BYTES,
  OUTPUT_PREVIEW_CHARS,
  createOutputReader,
  createReadLimiter,
  cutText,
  trimLargeOutput,
} from "./entry-output.js";

/** KOBE-208 review: bounded offloaded reads (timeout, queue, aborts) and code-point-safe cuts. */
const ids = { teamId: randomUUID(), threadId: randomUUID(), entryId: "e1" };
const key = `kobe/teams/${ids.teamId}/threads/${ids.threadId}/entries/e1`;
const body = JSON.stringify({
  message: { role: "toolResult", toolCallId: "c1", content: [{ type: "text", text: "ok" }] },
});

function store(get: ObjectStore["get"]): BlobStore {
  return { prefix: "kobe/", objects: { get } as unknown as ObjectStore };
}
/** A store that never answers until the read is aborted. */
const stalled = store(
  (_key, options) =>
    new Promise((_resolve, reject) =>
      options?.signal?.addEventListener("abort", () => reject(options.signal?.reason)),
    ),
);
const working = store(async () => {
  const bytes = Buffer.from(body);
  return { body: Readable.from([bytes]), size: bytes.length };
});

function deferred() {
  let release = () => {};
  const done = new Promise<void>((resolve) => (release = resolve));
  return { done, release };
}

describe("offloaded output reads", () => {
  it("time out on a stalled store and free the slot for the next read", async () => {
    const read = createOutputReader({ max: 1, queueMax: 4, waitMs: 5_000, readMs: 50 });
    const slow = read(stalled, ids, key);
    const next = read(working, ids, key);
    expect(await slow).toBe("timed_out");
    expect(await next).toMatchObject({ tool_call_id: "c1", text: "ok" });
  });

  it("drop a waiter whose request was aborted: it never takes a slot", async () => {
    const run = createReadLimiter({ max: 1, queueMax: 4, waitMs: 5_000 });
    const held = deferred();
    const first = run(() => held.done);
    const abort = new AbortController();
    const skipped = vi.fn(async () => "skipped");
    const gone = run(skipped, abort.signal);
    const kept = run(async () => "kept");
    abort.abort();
    expect(await gone).toEqual({ ok: false, reason: "aborted" });
    held.release();
    expect(await first).toEqual({ ok: true, value: undefined });
    expect(await kept).toEqual({ ok: true, value: "kept" });
    expect(skipped).not.toHaveBeenCalled();
    // An already aborted request does not even queue.
    expect(await run(skipped, AbortSignal.abort())).toEqual({ ok: false, reason: "aborted" });
  });

  it("answer busy when the queue is full or the wait is too long", async () => {
    const run = createReadLimiter({ max: 1, queueMax: 1, waitMs: 30 });
    const held = deferred();
    const first = run(() => held.done);
    const waiting = run(async () => "late");
    expect(await run(async () => "no room")).toEqual({ ok: false, reason: "busy" });
    expect(await waiting).toEqual({ ok: false, reason: "busy" });
    held.release();
    await first;
    expect(await run(async () => "free")).toEqual({ ok: true, value: "free" });
  });
});

describe("cuts on code-point boundaries", () => {
  it("never splits a surrogate pair", () => {
    expect(cutText("ab😀", 3)).toBe("ab");
    expect(cutText("ab😀", 4)).toBe("ab😀");
    expect(cutText("abc", 5)).toBe("abc");
  });

  it("keeps an emoji at the preview's edge whole or drops it", () => {
    const text = `${"a".repeat(OUTPUT_PREVIEW_CHARS - 1)}😀${"b".repeat(OUTPUT_INLINE_MAX_BYTES)}`;
    const payload = { message: { role: "toolResult", content: [{ type: "text", text }] } };
    const { payload: trimmed, truncated } = trimLargeOutput(payload);
    expect(truncated).toBe(true);
    const preview = (trimmed as typeof payload).message.content[0]?.text ?? "";
    expect(preview).toBe("a".repeat(OUTPUT_PREVIEW_CHARS - 1));
    // No lone surrogate: a UTF-8 round trip leaves the text as it was.
    expect(Buffer.from(preview, "utf8").toString("utf8")).toBe(preview);
  });
});
