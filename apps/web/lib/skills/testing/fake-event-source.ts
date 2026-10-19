import type { EventSourceFactory, EventSourceLike } from "../../chat/stream";

/** A scripted EventSource for the eval stream tests: emit events and errors by hand. */
export class FakeEvalStream {
  readonly urls: string[] = [];
  readonly sources: FakeSource[] = [];
  readonly factory: EventSourceFactory = (url) => {
    this.urls.push(url);
    const s = new FakeSource();
    this.sources.push(s);
    return s;
  };
}

export class FakeSource implements EventSourceLike {
  readyState = 1;
  onopen: ((event: Event) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  closed = false;
  private readonly listeners = new Map<string, ((event: MessageEvent<string>) => void)[]>();
  addEventListener(type: string, listener: (event: MessageEvent<string>) => void): void {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
  }
  close(): void {
    this.closed = true;
    this.readyState = 2;
  }
  emit(type: string, data: unknown = {}): void {
    for (const l of this.listeners.get(type) ?? [])
      l(new MessageEvent(type, { data: JSON.stringify(data) }));
  }
  fail(): void {
    this.onerror?.(new Event("error"));
  }
}

/**
 * Breaks the stream of `url` until the hook gives up on it: each failure is followed by the
 * retry delay (doubling), until `retries` reopenings have failed too.
 */
export async function breakStream(
  stream: FakeEvalStream,
  advance: (ms: number) => Promise<unknown>,
  retries: number,
  firstDelayMs: number,
): Promise<void> {
  for (let i = 0; i <= retries; i += 1) {
    stream.sources.at(-1)?.fail();
    if (i < retries) await advance(firstDelayMs * 2 ** i + 10);
  }
}
