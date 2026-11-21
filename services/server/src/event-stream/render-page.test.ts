import { describe, expect, it } from "vitest";
import { formatSseEvent, type KobeEvent } from "@kobe/protocol";
import { renderPage, type EpilogueTracking } from "./stream.js";

const RUN = "0b6f0d4e-5a3c-4d8e-9a43-5f7b0f2d1c11";
const TS = "2026-11-20T10:00:00.000Z";

const delta = (seq: number): KobeEvent =>
  ({
    run_id: RUN,
    seq,
    ts: TS,
    type: "text.delta",
    payload: { message_id: "m", content_index: 0, delta: String(seq) },
  }) as KobeEvent;

const completed = (seq: number, epilogue?: string[]): KobeEvent =>
  ({
    run_id: RUN,
    seq,
    ts: TS,
    type: "run.completed",
    payload: { leaf_entry_id: null, ...(epilogue ? { epilogue } : {}) },
  }) as KobeEvent;

const titled = (seq: number): KobeEvent =>
  ({
    run_id: RUN,
    seq,
    ts: TS,
    type: "thread.updated",
    payload: { thread_id: RUN, title: "Revenue" },
  }) as KobeEvent;

const page = (events: KobeEvent[], lastSeq = events.at(-1)?.seq ?? 0) => ({
  run: { ended: false, compacted: false, lastSeq },
  events,
});

const sse = (events: KobeEvent[]) => events.map((e) => formatSseEvent(e)).join("");

describe("renderPage (KOBE-730)", () => {
  it("renders every event after lastSent and advances lastSent", () => {
    const events = [delta(1), delta(2), delta(3)];
    const out = renderPage(page(events), 0, undefined);
    expect(out).toMatchObject({ text: sse(events), lastSent: 3, terminal: false, dirty: false });
    expect(out.announced).toEqual([]);
    expect(out.epilogue).toBeUndefined();
  });

  it("skips events at or before lastSent (a stale page)", () => {
    const out = renderPage(page([delta(1), delta(2), delta(3)]), 2, undefined);
    expect(out.text).toBe(sse([delta(3)]));
    expect(out.lastSent).toBe(3);
    const none = renderPage(page([delta(1), delta(2)]), 2, undefined);
    expect(none).toMatchObject({ text: "", lastSent: 2, dirty: false });
  });

  it("stops at a terminal event mid-page: nothing after it is sent", () => {
    const out = renderPage(page([delta(1), completed(2), delta(3)]), 0, undefined);
    expect(out.text).toBe(sse([delta(1), completed(2)]));
    expect(out).toMatchObject({ lastSent: 2, terminal: true });
    // The run's log goes on past what was sent: the stream would read again (it ends first).
    expect(out.dirty).toBe(true);
  });

  it("a run.completed announcing an epilogue keeps going and starts tracking it", () => {
    const out = renderPage(page([delta(1), completed(2, ["title"]), titled(3)]), 0, undefined);
    expect(out.text).toBe(sse([delta(1), completed(2, ["title"]), titled(3)]));
    expect(out.terminal).toBe(false);
    expect(out.lastSent).toBe(3);
    expect(out.announced).toEqual([
      { purposes: ["title"], written: new Set(), completedAtMs: Date.parse(TS) },
    ]);
    expect(out.epilogue?.state.purposes).toEqual(["title"]);
    // Events after the announcement count as written for it.
    expect([...(out.epilogue?.written ?? [])]).toEqual(["thread.updated"]);
  });

  it("records written event types on an epilogue already tracked, without changing the input", () => {
    const tracked: EpilogueTracking = {
      state: { purposes: ["title"], written: new Set(), completedAtMs: Date.parse(TS) },
      written: new Set(),
    };
    const out = renderPage(page([titled(5)]), 4, tracked);
    expect([...(out.epilogue?.written ?? [])]).toEqual(["thread.updated"]);
    expect(tracked.written.size).toBe(0);
  });

  it("leaves the stream dirty while the run's last seq is past what was sent", () => {
    expect(renderPage(page([delta(1), delta(2)], 9), 0, undefined).dirty).toBe(true);
    expect(renderPage(page([delta(1), delta(2)], 2), 0, undefined).dirty).toBe(false);
  });
});
