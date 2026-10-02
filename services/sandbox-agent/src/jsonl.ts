/**
 * Strict JSONL framing for Pi RPC (verified Pi 1.0.0, docs/rpc.md): records are split on LF only,
 * an optional CR before the LF is stripped. Node `readline` is not used because it also splits on
 * U+2028/U+2029, which are valid inside JSON strings.
 *
 * Buffers are bounded: a record longer than `maxLineBytes` is discarded up to its terminating LF
 * and reported through `onOversize`, so a runaway child cannot grow the agent's memory.
 */
export interface LineSplitterOptions {
  readonly maxLineBytes: number;
  readonly onLine: (line: string) => void;
  readonly onOversize?: (bytes: number) => void;
}

const LF = 0x0a;
const CR = 0x0d;

export class LineSplitter {
  readonly #options: LineSplitterOptions;
  #chunks: Buffer[] = [];
  #buffered = 0;
  /** Bytes of the current record dropped because it exceeded the limit (0 = not discarding). */
  #discarding = 0;

  constructor(options: LineSplitterOptions) {
    this.#options = options;
  }

  push(chunk: Buffer): void {
    let start = 0;
    while (start < chunk.length) {
      const lf = chunk.indexOf(LF, start);
      if (lf === -1) {
        this.#append(chunk.subarray(start));
        return;
      }
      this.#append(chunk.subarray(start, lf));
      this.#emit();
      start = lf + 1;
    }
  }

  /** Flush a final unterminated record (stream ended without a trailing LF). */
  end(): void {
    if (this.#buffered > 0 || this.#discarding > 0) this.#emit();
  }

  #append(part: Buffer): void {
    if (part.length === 0) return;
    if (this.#discarding > 0) {
      this.#discarding += part.length;
      return;
    }
    if (this.#buffered + part.length > this.#options.maxLineBytes) {
      this.#discarding = this.#buffered + part.length;
      this.#chunks = [];
      this.#buffered = 0;
      return;
    }
    // Copy: the caller may reuse the chunk's memory.
    this.#chunks.push(Buffer.from(part));
    this.#buffered += part.length;
  }

  #emit(): void {
    if (this.#discarding > 0) {
      const bytes = this.#discarding;
      this.#discarding = 0;
      this.#options.onOversize?.(bytes);
      return;
    }
    let line = Buffer.concat(this.#chunks, this.#buffered);
    this.#chunks = [];
    this.#buffered = 0;
    if (line.length > 0 && line[line.length - 1] === CR) line = line.subarray(0, line.length - 1);
    if (line.length === 0) return;
    this.#options.onLine(line.toString("utf8"));
  }
}

/** Encode one record for a Pi stdin / policy channel: JSON plus LF. */
export function encodeJsonl(value: unknown): string {
  return `${JSON.stringify(value)}\n`;
}
