import type { KobeEvent } from "@kobe/protocol";

export interface SseFrame {
  readonly id?: string;
  readonly event?: string;
  readonly data?: string;
  readonly retry?: number;
  readonly comment?: string;
}

/** Incremental SSE parser over a response body, for tests (spec-conformant enough for our frames). */
export class SseReader {
  private readonly reader: ReadableStreamDefaultReader<Uint8Array>;
  private readonly decoder = new TextDecoder();
  private buffer = "";
  private frames: SseFrame[] = [];
  done = false;

  constructor(body: ReadableStream<Uint8Array> | null) {
    if (!body) throw new Error("response has no body");
    this.reader = body.getReader();
  }

  /** Next frame, or undefined at end of stream. */
  async next(): Promise<SseFrame | undefined> {
    while (this.frames.length === 0) {
      if (this.done) return undefined;
      const { done, value } = await this.reader.read();
      if (done) {
        this.done = true;
        continue;
      }
      this.buffer += this.decoder.decode(value, { stream: true });
      let idx: number;
      while ((idx = this.buffer.indexOf("\n\n")) >= 0) {
        const block = this.buffer.slice(0, idx);
        this.buffer = this.buffer.slice(idx + 2);
        this.frames.push(parseBlock(block));
      }
    }
    return this.frames.shift();
  }

  /** Next event frame (skips keep-alives and retry), parsed; undefined at end of stream. */
  async nextEvent(): Promise<KobeEvent | undefined> {
    for (;;) {
      const frame = await this.next();
      if (!frame) return undefined;
      if (frame.data !== undefined) return JSON.parse(frame.data) as KobeEvent;
    }
  }

  /** Reads events until the stream ends. */
  async rest(): Promise<KobeEvent[]> {
    const out: KobeEvent[] = [];
    for (let e = await this.nextEvent(); e; e = await this.nextEvent()) out.push(e);
    return out;
  }

  async cancel(): Promise<void> {
    await this.reader.cancel().catch(() => undefined);
  }
}

function parseBlock(block: string): SseFrame {
  const frame: { -readonly [K in keyof SseFrame]: SseFrame[K] } = {};
  for (const line of block.split("\n")) {
    if (line.startsWith(":")) frame.comment = line.slice(1).trim();
    else if (line.startsWith("id: ")) frame.id = line.slice(4);
    else if (line.startsWith("event: ")) frame.event = line.slice(7);
    else if (line.startsWith("data: ")) frame.data = line.slice(6);
    else if (line.startsWith("retry: ")) frame.retry = Number(line.slice(7));
  }
  return frame;
}
