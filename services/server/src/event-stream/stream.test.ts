import { afterEach, describe, expect, it, vi } from "vitest";
import type { KobeEvent } from "@kobe/protocol";
import { SseReader } from "../testing/sse.js";
import type { HubSubscriber, RunEventHub } from "./hub.js";
import { PAGE_MAX_ROWS, type Page } from "./read.js";
import { createRunEventStream, type StreamEndReason, type StreamTimings } from "./stream.js";

const RUN = "0b6f0d4e-5a3c-4d8e-9a43-5f7b0f2d1c11";

/** In-memory run log standing in for Postgres. */
class FakeLog {
  events: KobeEvent[] = [];
  ended = false;
  compacted = false;
  exists = true;
  reads = 0;
  allowed = true;
  failNextRead = false;

  append(n: number, terminal = false): void {
    for (let i = 0; i < n; i++) {
      const seq = this.events.length + 1;
      const last = terminal && i === n - 1;
      this.events.push(
        (last
          ? {
              run_id: RUN,
              seq,
              ts: new Date().toISOString(),
              type: "run.completed",
              payload: { leaf_entry_id: null },
            }
          : {
              run_id: RUN,
              seq,
              ts: new Date().toISOString(),
              type: "text.delta",
              payload: { message_id: "m", content_index: 0, delta: String(seq) },
            }) as KobeEvent,
      );
    }
    if (terminal) this.ended = true;
  }

  source = {
    read: async (after: number): Promise<Page> => {
      this.reads += 1;
      if (this.failNextRead) {
        this.failNextRead = false;
        throw new Error("db hiccup");
      }
      if (!this.exists) return { run: null, events: [] };
      return {
        run: { ended: this.ended, compacted: this.compacted, lastSeq: this.events.length },
        events: this.events.filter((e) => e.seq > after).slice(0, PAGE_MAX_ROWS),
      };
    },
    revalidate: async () => this.allowed,
  };
}

class FakeHub implements RunEventHub {
  subs = new Set<HubSubscriber>();
  state = "listening" as const;
  get size() {
    return this.subs.size;
  }
  subscribe(_runId: string, s: HubSubscriber) {
    this.subs.add(s);
    return () => this.subs.delete(s);
  }
  acquireSlot() {
    return () => undefined;
  }
  hint(seq: number) {
    for (const s of this.subs) s.hint(seq);
  }
  async close() {
    for (const s of this.subs) s.close();
  }
}

const FAST: Partial<StreamTimings> = {
  keepaliveMs: 20,
  safetyReadMs: 20,
  stallTimeoutMs: 200,
  revalidateMs: 50,
};

function open(log: FakeLog, hub: FakeHub, cursor = 0, timings = FAST) {
  const ends: StreamEndReason[] = [];
  const body = createRunEventStream({
    runId: RUN,
    cursor,
    source: log.source,
    hub,
    timings,
    onEnd: (r) => ends.push(r),
  });
  return { reader: new SseReader(body), ends };
}

const seqs = (events: KobeEvent[]) => events.map((e) => e.seq);
const range = (from: number, to: number) =>
  Array.from({ length: to - from + 1 }, (_, i) => from + i);

afterEach(() => vi.useRealTimers());

describe("run event stream", () => {
  it("starts with retry, replays after the cursor, streams live and closes after the terminal event", async () => {
    const log = new FakeLog();
    const hub = new FakeHub();
    log.append(5);
    const { reader, ends } = open(log, hub, 2);
    expect((await reader.next())?.retry).toBe(2_000);
    const first = await reader.next();
    expect(first?.id).toBe("3");
    expect(first?.event).toBe("text.delta");
    expect((await reader.nextEvent())?.seq).toBe(4);
    expect((await reader.nextEvent())?.seq).toBe(5);
    log.append(3, true);
    hub.hint(8);
    expect(seqs(await reader.rest())).toEqual([6, 7, 8]);
    expect(ends).toEqual(["terminal"]);
    expect(hub.size).toBe(0);
  });

  it("pages through long backlogs gaplessly", async () => {
    const log = new FakeLog();
    log.append(PAGE_MAX_ROWS * 3 + 7, true);
    const { reader } = open(log, new FakeHub());
    expect(seqs(await reader.rest())).toEqual(range(1, PAGE_MAX_ROWS * 3 + 7));
  });

  it("closes an ended run once caught up even without a terminal event", async () => {
    const log = new FakeLog();
    log.append(2);
    log.ended = true;
    const { reader, ends } = open(log, new FakeHub());
    expect(seqs(await reader.rest())).toEqual([1, 2]);
    expect(ends).toEqual(["terminal"]);
  });

  it("sends keep-alives while idle and re-reads after safetyReadMs (lost hints still arrive)", async () => {
    const log = new FakeLog();
    const hub = new FakeHub();
    const { reader } = open(log, hub);
    await reader.next(); // retry
    expect((await reader.next())?.comment).toBe("keepalive");
    log.append(1); // no hint sent
    expect((await reader.nextEvent())?.seq).toBe(1);
    await reader.cancel();
  });

  it("does not query Postgres on keep-alive ticks before safetyReadMs", async () => {
    const log = new FakeLog();
    const { reader } = open(log, new FakeHub(), 0, { keepaliveMs: 10, safetyReadMs: 60_000 });
    await reader.next(); // retry
    for (let i = 0; i < 5; i++) expect((await reader.next())?.comment).toBe("keepalive");
    expect(log.reads).toBe(1); // the initial replay only
    await reader.cancel();
  });

  it("does not read ahead for a client that is not reading (Postgres is the buffer)", async () => {
    const log = new FakeLog();
    const hub = new FakeHub();
    const { reader, ends } = open(log, hub, 0, {
      keepaliveMs: 10,
      safetyReadMs: 10,
      stallTimeoutMs: 10_000,
    });
    await reader.next(); // retry consumed; one pull may run
    await new Promise((r) => setTimeout(r, 30));
    const readsBefore = log.reads;
    for (let i = 0; i < 100; i++) {
      log.append(10);
      hub.hint(log.events.length);
    }
    await new Promise((r) => setTimeout(r, 50));
    // At most one page was read for the chunk waiting in the queue; hints only set a flag.
    expect(log.reads - readsBefore).toBeLessThanOrEqual(1);
    const got: number[] = [];
    for (let i = 0; i < 60; i++) got.push((await reader.nextEvent())?.seq ?? -1);
    expect(got).toEqual(range(1, 60));
    await reader.cancel();
    expect(ends).toEqual(["client_closed"]);
  });

  it("errors the stream for a client that stops reading (slow consumer)", async () => {
    const log = new FakeLog();
    const hub = new FakeHub();
    log.append(PAGE_MAX_ROWS * 4);
    const { reader, ends } = open(log, hub, 0, { keepaliveMs: 10, stallTimeoutMs: 60 });
    await reader.next();
    await new Promise((r) => setTimeout(r, 200));
    expect(ends).toEqual(["slow_consumer"]);
    expect(hub.size).toBe(0);
    await expect(
      (async () => {
        for (;;) if (!(await reader.next())) return;
      })(),
    ).rejects.toThrow("slow consumer");
  });

  it("ends when access is revoked", async () => {
    const log = new FakeLog();
    const { reader, ends } = open(log, new FakeHub());
    log.allowed = false;
    expect(await reader.rest()).toEqual([]);
    expect(ends).toEqual(["revoked"]);
  });

  it("ends when the run disappears or is compacted", async () => {
    const log = new FakeLog();
    log.append(1);
    const a = open(log, new FakeHub());
    expect((await a.reader.nextEvent())?.seq).toBe(1);
    log.exists = false;
    expect(await a.reader.rest()).toEqual([]);
    expect(a.ends).toEqual(["gone"]);
  });

  it("closes cleanly on a read error so the client resumes", async () => {
    const log = new FakeLog();
    log.append(1);
    log.failNextRead = true;
    const { reader, ends } = open(log, new FakeHub());
    expect(await reader.rest()).toEqual([]);
    expect(ends).toEqual(["error"]);
  });

  it("closes on hub shutdown and cleans up exactly once", async () => {
    const log = new FakeLog();
    const hub = new FakeHub();
    const { reader, ends } = open(log, hub, 0, { keepaliveMs: 10_000 });
    await reader.next();
    const pending = reader.next();
    await hub.close();
    expect(await pending).toBeUndefined();
    await reader.cancel();
    expect(ends).toEqual(["shutdown"]);
  });

  it("never sends a seq twice when hints and reads interleave", async () => {
    const log = new FakeLog();
    const hub = new FakeHub();
    const { reader } = open(log, hub, 0, {
      keepaliveMs: 5,
      safetyReadMs: 5,
      stallTimeoutMs: 10_000,
    });
    const writer = (async () => {
      for (let i = 0; i < 40; i++) {
        log.append(1 + (i % 3));
        if (i % 2) hub.hint(log.events.length);
        await new Promise((r) => setTimeout(r, 1));
      }
      log.append(1, true);
      hub.hint(log.events.length);
    })();
    const got = await reader.rest();
    await writer;
    expect(seqs(got)).toEqual(range(1, log.events.length));
  });
});
