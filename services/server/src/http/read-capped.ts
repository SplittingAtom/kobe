/**
 * Reading a body with a byte cap (KOBE-702): a reply or object that grows past the cap is refused
 * while it streams, never buffered whole. Bytes are joined before decoding, so a multibyte
 * character split across chunks survives.
 */

/** A fetch reply's body as UTF-8 text, or undefined once it passes `max` bytes. */
export async function readCapped(res: Response, max: number): Promise<string | undefined> {
  if (!res.body) return "";
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > max) {
      await reader.cancel();
      return undefined;
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString("utf8");
}

/**
 * A stream's bytes (a Node `Readable`, an S3 body, any async iterable of byte chunks), or undefined
 * once it passes `max` bytes; the stream is destroyed then when it can be. A stream error rejects.
 */
export async function readCappedStream(
  body: AsyncIterable<unknown> & { destroy?: () => unknown },
  max: number,
): Promise<Buffer | undefined> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of body) {
    const b = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array);
    size += b.length;
    if (size > max) {
      if (typeof body.destroy === "function") body.destroy();
      return undefined;
    }
    chunks.push(b);
  }
  return Buffer.concat(chunks);
}
