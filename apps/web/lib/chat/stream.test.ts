import type { KobeEvent } from "@kobe/protocol";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { openRunStream, type EventSourceLike, type StreamSignal } from "./stream";
import { must } from "../testing/must";

const RUN = "00000000-0000-4000-8000-000000000101";
const THREAD = "00000000-0000-4000-8000-000000000201";

class StubSource implements EventSourceLike {
  readyState = 0;
  onopen: ((event: Event) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  closed = false;
  readonly listeners = new Map<string, ((event: MessageEvent<string>) => void)[]>();
  constructor(readonly url: string) {}
  addEventListener(type: string, listener: (event: MessageEvent<string>) => void) {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
  }
  close() {
    this.closed = true;
    this.readyState = 2;
  }
  send(type: string, data: string) {
    for (const l of this.listeners.get(type) ?? []) l(new MessageEvent(type, { data }));
  }
}

function delta(seq: number, text: string): KobeEvent {
  return {
    run_id: RUN,
    seq,
    ts: "2026-10-02T10:00:00Z",
    type: "text.delta",
    payload: { message_id: "m1", content_index: 0, delta: text },
  };
}

let sources: StubSource[];
const factory = (url: string) => {
  const s = new StubSource(url);
  sources.push(s);
  return s;
};

beforeEach(() => {
  sources = [];
  vi.useFakeTimers();
});
afterEach(() => vi.useRealTimers());

describe("openRunStream", () => {
  it("opens the run's SSE URL after the cursor and batches events in seq order", () => {
    const batches: KobeEvent[][] = [];
    openRunStream(RUN, 4, { onEvents: (e) => batches.push([...e]), onSignal: () => {} }, factory);
    expect(sources[0]?.url).toBe(`/v1/runs/${RUN}/events?starting_after=4`);
    const s = must(sources[0]);
    s.send("text.delta", JSON.stringify(delta(5, "a")));
    s.send("text.delta", JSON.stringify(delta(6, "b")));
    expect(batches).toEqual([]);
    vi.advanceTimersByTime(40);
    expect(batches.map((b) => b.map((e) => e.seq))).toEqual([[5, 6]]);
  });

  it("drops duplicates, other runs' events and anything that fails the contract", () => {
    const seen: number[] = [];
    openRunStream(
      RUN,
      0,
      { onEvents: (e) => seen.push(...e.map((x) => x.seq)), onSignal: () => {} },
      factory,
    );
    const s = must(sources[0]);
    s.send("text.delta", JSON.stringify(delta(1, "a")));
    s.send("text.delta", JSON.stringify(delta(1, "a")));
    s.send("text.delta", JSON.stringify({ ...delta(2, "x"), run_id: THREAD }));
    s.send("text.delta", JSON.stringify({ ...delta(3, "x"), payload: { delta: 5 } }));
    s.send("text.delta", "not json");
    s.send("text.delta", JSON.stringify(delta(2, "b")));
    vi.advanceTimersByTime(40);
    expect(seen).toEqual([1, 2]);
  });

  it("closes itself after a terminal event, flushing what it holds", () => {
    const seen: string[] = [];
    const signals: StreamSignal[] = [];
    openRunStream(
      RUN,
      0,
      { onEvents: (e) => seen.push(...e.map((x) => x.type)), onSignal: (s) => signals.push(s) },
      factory,
    );
    const s = must(sources[0]);
    s.send("text.delta", JSON.stringify(delta(1, "a")));
    s.send(
      "run.completed",
      JSON.stringify({
        run_id: RUN,
        seq: 2,
        ts: "2026-10-02T10:00:00Z",
        type: "run.completed",
        payload: { leaf_entry_id: null },
      }),
    );
    expect(seen).toEqual(["text.delta", "run.completed"]);
    expect(s.closed).toBe(true);
    expect(signals).toEqual([{ kind: "closed" }]);
  });

  it("reports a dropped connection while the browser reconnects, and a refusal as closed", () => {
    const signals: StreamSignal[] = [];
    openRunStream(RUN, 0, { onEvents: () => {}, onSignal: (s) => signals.push(s) }, factory);
    const s = must(sources[0]);
    s.readyState = 1;
    s.onopen?.(new Event("open"));
    s.readyState = 0;
    s.onerror?.(new Event("error"));
    s.readyState = 2;
    s.onerror?.(new Event("error"));
    expect(signals).toEqual([{ kind: "open" }, { kind: "reconnecting" }, { kind: "closed" }]);
  });

  it("close() stops delivery without a signal", () => {
    const seen: number[] = [];
    const signals: StreamSignal[] = [];
    const stream = openRunStream(
      RUN,
      0,
      { onEvents: (e) => seen.push(...e.map((x) => x.seq)), onSignal: (s) => signals.push(s) },
      factory,
    );
    stream.close();
    must(sources[0]).send("text.delta", JSON.stringify(delta(1, "a")));
    vi.advanceTimersByTime(40);
    expect(seen).toEqual([]);
    expect(signals).toEqual([]);
    expect(must(sources[0]).closed).toBe(true);
  });
});
