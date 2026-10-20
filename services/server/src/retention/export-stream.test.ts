import { describe, expect, it, vi } from "vitest";
import { trackedDownload } from "./export-stream.js";

const bytes = (s: string) => new TextEncoder().encode(s);
const text = async (body: ReadableStream<Uint8Array>) => new Response(body).text();

/** A stream that yields `chunks`, then fails with `err` (if given). */
function source(chunks: readonly string[], err?: Error): ReadableStream<Uint8Array> {
  let i = 0;
  return new ReadableStream<Uint8Array>({
    pull(c) {
      if (i < chunks.length) c.enqueue(bytes(chunks[i++] ?? ""));
      else if (err) c.error(err);
      else c.close();
    },
  });
}

describe("trackedDownload (KOBE-450 review LOW-2)", () => {
  it("passes the body through and releases once at the end", async () => {
    const release = vi.fn();
    const failed = vi.fn();
    expect(await text(trackedDownload(source(["a", "b"]), { release, failed }))).toBe("ab");
    expect(release).toHaveBeenCalledTimes(1);
    expect(failed).not.toHaveBeenCalled();
  });

  it("a failure is reported, releases, and ends with the tail when there is one", async () => {
    const release = vi.fn();
    const failed = vi.fn();
    const boom = new Error("s3 down");
    const body = trackedDownload(source(["a"], boom), { release, failed, tail: bytes("!") });
    expect(await text(body)).toBe("a!");
    expect(failed).toHaveBeenCalledWith(boom);
    expect(release).toHaveBeenCalledTimes(1);
  });

  it("without a tail the stream errors", async () => {
    const release = vi.fn();
    const body = trackedDownload(source([], new Error("x")), { release, failed: vi.fn() });
    await expect(text(body)).rejects.toThrow();
    expect(release).toHaveBeenCalledTimes(1);
  });

  it("a cancelled download releases", async () => {
    const release = vi.fn();
    const body = trackedDownload(source(["a", "b"]), { release, failed: vi.fn() });
    await body.cancel("gone");
    expect(release).toHaveBeenCalledTimes(1);
  });
});
