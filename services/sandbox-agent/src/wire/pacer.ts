/**
 * Outbound send pacing (KOBE-429). The server charges every inbound frame against a per-connection
 * frame and byte token bucket and closes the connection on the first frame over it (connection.ts
 * `#rateOk`). A reconnect replays the whole un-acked backlog at once, which could exceed that and
 * get the connection closed again and again. The agent therefore runs the same kind of bucket,
 * set below the server's (`SANDBOX_SEND_PACE`), and holds frames in a FIFO queue until it
 * has the tokens: order is kept, nothing is dropped while the connection lives.
 */
export interface PaceLimits {
  readonly framesPerSec: number;
  readonly frameBurst: number;
  readonly bytesPerSec: number;
  readonly byteBurst: number;
}

export class SendPacer {
  readonly #limits: PaceLimits;
  readonly #write: (text: string) => void;
  readonly #queue: { text: string; bytes: number }[] = [];
  #head = 0;
  #frames: number;
  #bytes: number;
  #at = Date.now();
  #timer: NodeJS.Timeout | undefined;
  #draining = false;

  constructor(limits: PaceLimits, write: (text: string) => void) {
    this.#limits = limits;
    this.#write = write;
    this.#frames = limits.frameBurst;
    this.#bytes = limits.byteBurst;
  }

  /** Frames waiting for tokens. */
  get queued(): number {
    return this.#queue.length - this.#head;
  }

  send(text: string): void {
    this.#queue.push({ text, bytes: Buffer.byteLength(text) });
    if (this.#timer === undefined && !this.#draining) this.#drain();
  }

  /** A new connection: forget what was queued for the old one and start with full buckets. */
  reset(): void {
    clearTimeout(this.#timer);
    this.#timer = undefined;
    this.#queue.length = 0;
    this.#head = 0;
    this.#frames = this.#limits.frameBurst;
    this.#bytes = this.#limits.byteBurst;
    this.#at = Date.now();
  }

  #refill(): void {
    const now = Date.now();
    const elapsed = (now - this.#at) / 1000;
    this.#at = now;
    const { framesPerSec, frameBurst, bytesPerSec, byteBurst } = this.#limits;
    this.#frames = Math.min(frameBurst, this.#frames + elapsed * framesPerSec);
    this.#bytes = Math.min(byteBurst, this.#bytes + elapsed * bytesPerSec);
  }

  #drain(): void {
    this.#timer = undefined;
    this.#draining = true;
    try {
      this.#drainQueued();
    } finally {
      this.#draining = false;
    }
  }

  #drainQueued(): void {
    this.#refill();
    while (this.#head < this.#queue.length) {
      const next = this.#queue[this.#head];
      if (next === undefined) break;
      // A frame bigger than the byte burst goes out once the bucket is full (never stalls).
      const needBytes = Math.min(next.bytes, this.#limits.byteBurst);
      if (this.#frames < 1 || this.#bytes < needBytes) {
        this.#schedule(needBytes);
        this.#compact();
        return;
      }
      this.#frames -= 1;
      this.#bytes -= next.bytes;
      this.#head += 1;
      this.#write(next.text);
    }
    this.#queue.length = 0;
    this.#head = 0;
  }

  /** Drop sent entries from the front now and then, so a long backlog does not stay in memory. */
  #compact(): void {
    if (this.#head < 1024 || this.#head * 2 < this.#queue.length) return;
    this.#queue.splice(0, this.#head);
    this.#head = 0;
  }

  #schedule(needBytes: number): void {
    const { framesPerSec, bytesPerSec } = this.#limits;
    const frameWait = Math.max(0, 1 - this.#frames) / framesPerSec;
    const byteWait = Math.max(0, needBytes - this.#bytes) / bytesPerSec;
    const ms = Math.max(1, Math.ceil(Math.max(frameWait, byteWait) * 1000));
    this.#timer = setTimeout(() => this.#drain(), ms);
  }
}
