import { createHash } from "node:crypto";
import { Transform, type TransformCallback } from "node:stream";
import { SNIFF_BYTES } from "./mime.js";

export class UploadTooLargeError extends Error {
  constructor(readonly limitBytes: number) {
    super(`upload exceeds ${limitBytes} bytes`);
    this.name = "UploadTooLargeError";
  }
}

/**
 * Passes bytes through while counting, hashing (SHA-256) and keeping the first bytes for mime
 * sniffing; errors out as soon as more than `limitBytes` have passed, so an oversized upload is
 * cut off mid-stream and never fully received.
 */
export class UploadMeter extends Transform {
  private readonly hash = createHash("sha256");
  private seen = 0;
  private readonly first: Buffer[] = [];
  private firstLength = 0;

  constructor(private readonly limitBytes: number) {
    super();
  }

  get bytes(): number {
    return this.seen;
  }

  get head(): Uint8Array {
    return Buffer.concat(this.first).subarray(0, SNIFF_BYTES);
  }

  digest(): string {
    return this.hash.copy().digest("hex");
  }

  override _transform(chunk: Buffer, _enc: BufferEncoding, done: TransformCallback): void {
    this.seen += chunk.length;
    if (this.seen > this.limitBytes) {
      done(new UploadTooLargeError(this.limitBytes));
      return;
    }
    this.hash.update(chunk);
    if (this.firstLength < SNIFF_BYTES) {
      this.first.push(chunk.subarray(0, SNIFF_BYTES - this.firstLength));
      this.firstLength += Math.min(chunk.length, SNIFF_BYTES - this.firstLength);
    }
    done(null, chunk);
  }
}
