/**
 * LF-split JSONL reader for the policy channel (same framing as Pi RPC: LF only, optional CR
 * stripped; `readline` would also split on U+2028/U+2029). A line over `maxLineBytes` is reported
 * through `onOversize` and the reader stops: an oversize reply means the channel is not trustworthy.
 * Kept here, not shared with the agent's `jsonl.ts`, because the extension ships without the agent.
 */
export class LineReader {
  readonly #maxLineBytes: number;
  readonly #onLine: (line: string) => void;
  readonly #onOversize: () => void;
  #chunks: Buffer[] = [];
  #buffered = 0;
  #stopped = false;

  constructor(maxLineBytes: number, onLine: (line: string) => void, onOversize: () => void) {
    this.#maxLineBytes = maxLineBytes;
    this.#onLine = onLine;
    this.#onOversize = onOversize;
  }

  push(chunk: Buffer): void {
    let start = 0;
    while (!this.#stopped && start < chunk.length) {
      const lf = chunk.indexOf(0x0a, start);
      const end = lf === -1 ? chunk.length : lf;
      if (!this.#append(chunk.subarray(start, end))) return;
      if (lf === -1) return;
      this.#emit();
      start = lf + 1;
    }
  }

  #append(part: Buffer): boolean {
    if (part.length === 0) return true;
    if (this.#buffered + part.length > this.#maxLineBytes) {
      this.#stopped = true;
      this.#chunks = [];
      this.#buffered = 0;
      this.#onOversize();
      return false;
    }
    this.#chunks.push(Buffer.from(part));
    this.#buffered += part.length;
    return true;
  }

  #emit(): void {
    let line = Buffer.concat(this.#chunks, this.#buffered);
    this.#chunks = [];
    this.#buffered = 0;
    if (line.length > 0 && line[line.length - 1] === 0x0d) line = line.subarray(0, -1);
    if (line.length > 0) this.#onLine(line.toString("utf8"));
  }
}
