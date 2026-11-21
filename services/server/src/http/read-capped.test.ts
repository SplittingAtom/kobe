import { Readable } from "node:stream";
import { describe, expect, it } from "vitest";
import { readCapped, readCappedStream } from "./read-capped.js";

const bytes = (s: string) => new TextEncoder().encode(s);

function responseOf(chunks: Uint8Array[]): Response {
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const c of chunks) controller.enqueue(c);
      controller.close();
    },
  });
  return new Response(stream);
}

describe("readCapped (Response)", () => {
  it("reads a body exactly at the cap", async () => {
    expect(await readCapped(responseOf([bytes("ab"), bytes("cd")]), 4)).toBe("abcd");
  });

  it("refuses a body one byte over the cap", async () => {
    expect(await readCapped(responseOf([bytes("ab"), bytes("cde")]), 4)).toBeUndefined();
  });

  it("joins a multibyte character split across chunks and counts bytes, not characters", async () => {
    const euro = bytes("€"); // 3 bytes
    const chunks = [euro.slice(0, 1), euro.slice(1)];
    expect(await readCapped(responseOf(chunks), 3)).toBe("€");
    expect(await readCapped(responseOf([euro.slice(0, 2), euro.slice(2)]), 2)).toBeUndefined();
  });

  it("reads an empty body as empty text", async () => {
    expect(await readCapped(new Response(null), 4)).toBe("");
  });
});

describe("readCappedStream", () => {
  it("reads a stream exactly at the cap", async () => {
    const out = await readCappedStream(Readable.from([Buffer.from("ab"), Buffer.from("cd")]), 4);
    expect(out?.toString()).toBe("abcd");
  });

  it("refuses one byte over the cap and destroys the stream", async () => {
    const stream = Readable.from([Buffer.from("ab"), Buffer.from("cde"), Buffer.from("f")]);
    expect(await readCappedStream(stream, 4)).toBeUndefined();
    expect(stream.destroyed).toBe(true);
  });

  it("keeps a multibyte character split across chunks intact", async () => {
    const euro = Buffer.from("€");
    const out = await readCappedStream(Readable.from([euro.subarray(0, 1), euro.subarray(1)]), 3);
    expect(out?.toString("utf8")).toBe("€");
  });

  it("reads a plain async iterable of Uint8Array chunks", async () => {
    async function* gen() {
      yield bytes("x");
      yield bytes("y");
    }
    expect((await readCappedStream(gen(), 2))?.toString()).toBe("xy");
    expect(await readCappedStream(gen(), 1)).toBeUndefined();
  });
});
