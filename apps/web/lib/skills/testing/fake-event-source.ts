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
