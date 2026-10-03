import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { KobeEvent } from "@kobe/protocol";
import { sql, withTeam } from "@kobe/db";
import {
  AppendError,
  MAX_APPEND_BATCH,
  MAX_EVENT_PAYLOAD_BYTES,
  appendRunEvents,
  appendRunEventsInTx,
} from "./event-stream/append.js";
import { createRunEventBatcher } from "./event-stream/batcher.js";
import { RUN_EVENTS_CHANNEL } from "./event-stream/notify.js";
import { SseReader } from "./testing/sse.js";
import {
  EventStreamFixture,
  delta,
  range,
  seededRandom,
  type Person,
} from "./testing/event-stream-fixture.js";

// Replica 0 and 1: keep-alive far away, so live delivery below proves the NOTIFY path.
// Replica 2: fast timers for revocation and per-user caps.
const fx = new EventStreamFixture();
let alice: Person; // finance member, owns the runs
let bob: Person; // finance member (teammate)
let fran: Person; // finance team admin
let mallory: Person; // marketing team admin
let finance = "";
let marketing = "";

beforeAll(async () => {
  await fx.setup([
    { timings: { keepaliveMs: 10_000 } },
    { timings: { keepaliveMs: 10_000 } },
    {
      timings: { keepaliveMs: 50, revalidateMs: 100, stallTimeoutMs: 5_000 },
      hub: { maxStreamsPerUser: 2 },
    },
  ]);
  [alice, bob, fran, mallory] = (await Promise.all(
    ["alice", "bob", "fran", "mallory"].map((n) => fx.person(n)),
  )) as [Person, Person, Person, Person];
  finance = await fx.team("finance", fran, [alice, bob]);
  marketing = await fx.team("marketing", mallory);
});

afterAll(() => fx.teardown());

const seqs = (events: readonly KobeEvent[]) => events.map((e) => e.seq);

/** Waits until some backend is blocked on a lock while touching `runId` (B queued behind A). */
async function waitForLockWaiter(runId: string): Promise<void> {
  const deadline = Date.now() + 10_000;
  for (;;) {
    const { rows } = await fx.admin.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM pg_stat_activity
        WHERE datname = current_database() AND wait_event_type = 'Lock'`,
    );
    if ((rows[0]?.n ?? 0) > 0) return;
    if (Date.now() > deadline) throw new Error(`no lock waiter for run ${runId}`);
    await new Promise((r) => setTimeout(r, 10));
  }
}

describe("append (ac-1)", () => {
  it("validates, assigns gapless seq and returns envelopes", async () => {
    const run = await fx.run(finance, alice);
    const written = await appendRunEvents(fx.db, finance, run, [
      { type: "sandbox.waking", payload: { reason: "hibernated" } },
      delta("Hello"),
    ]);
    expect(written).toMatchObject([
      { run_id: run, seq: 1, type: "sandbox.waking", payload: { reason: "hibernated" } },
      { run_id: run, seq: 2, type: "text.delta", payload: { delta: "Hello" } },
    ]);
    expect(written[0]?.ts).toMatch(/Z$/);
    expect(await appendRunEvents(fx.db, finance, run, [])).toEqual([]);
  });

  it("rejects bad events, oversized batches and terminal-not-last before writing", async () => {
    const run = await fx.run(finance, alice);
    const code = (p: Promise<unknown>) =>
      p.then(
        () => "ok",
        (e: unknown) => (e instanceof AppendError ? e.code : String(e)),
      );
    expect(
      await code(appendRunEvents(fx.db, finance, run, [{ type: "nope.x", payload: {} }])),
    ).toBe("invalid_event");
    expect(
      await code(
        appendRunEvents(fx.db, finance, run, [{ type: "text.delta", payload: { delta: "x" } }]),
      ),
    ).toBe("invalid_event");
    expect(
      await code(
        appendRunEvents(fx.db, finance, run, [delta("x".repeat(MAX_EVENT_PAYLOAD_BYTES))]),
      ),
    ).toBe("payload_too_large");
    expect(await code(appendRunEvents(fx.db, finance, run, [delta("a\u0000b")]))).toBe(
      "invalid_event",
    );
    expect(
      await code(
        appendRunEvents(
          fx.db,
          finance,
          run,
          range(1, MAX_APPEND_BATCH + 1).map(() => delta("x")),
        ),
      ),
    ).toBe("batch_too_large");
    expect(
      await code(
        appendRunEvents(fx.db, finance, run, [
          { type: "run.completed", payload: { leaf_entry_id: null } },
          delta("late"),
        ]),
      ),
    ).toBe("terminal_not_last");
    expect(await fx.seqsInDb(finance, run)).toEqual([]);
  });

  it("refuses another team's run and appends after the terminal event", async () => {
    const run = await fx.run(finance, alice);
    await expect(appendRunEvents(fx.db, marketing, run, [delta("x")])).rejects.toMatchObject({
      code: "run_not_found",
    });
    await fx.complete(finance, run);
    await expect(appendRunEvents(fx.db, finance, run, [delta("x")])).rejects.toMatchObject({
      code: "run_finished",
    });
    expect(await fx.seqsInDb(finance, run)).toEqual([1]);
  });

  it.each([
    ["run.completed", { leaf_entry_id: null }],
    ["run.interrupted", { reason: "cancelled", last_entry_id: null, retryable: false }],
  ] as const)(
    "refuses an append that waited on the run lock behind a terminal %s (review HIGH-1)",
    async (type, payload) => {
      const run = await fx.run(finance, alice);
      let release!: () => void;
      const gate = new Promise<void>((r) => (release = r));
      let appended!: () => void;
      const terminalWritten = new Promise<void>((r) => (appended = r));
      // A: the orchestrator ends the run and holds its transaction open.
      const a = withTeam(fx.db, finance, async (tx) => {
        await appendRunEventsInTx(tx, finance, run, [{ type, payload }]);
        appended();
        await gate;
      });
      await terminalWritten;
      // B: a batcher flush for the same run, which must wait for A's row lock.
      const b = appendRunEvents(fx.replica(1).deps.database.db, finance, run, [delta("late")]).then(
        () => "ok",
        (e: unknown) => (e instanceof AppendError ? e.code : String(e)),
      );
      await waitForLockWaiter(run);
      release();
      await a;
      expect(await b).toBe("run_finished");
      expect(await fx.seqsInDb(finance, run)).toEqual([1]);
    },
  );

  it("hints fan-out with ids only, and only when the transaction commits", async () => {
    const run = await fx.run(finance, alice);
    const listener = new pg.Client({ connectionString: fx.database.appUrl });
    await listener.connect();
    try {
      const heard: string[] = [];
      listener.on("notification", (m) => heard.push(m.payload ?? ""));
      await listener.query(`LISTEN ${RUN_EVENTS_CHANNEL}`);
      await withTeam(fx.db, finance, async (tx) => {
        await appendRunEventsInTx(tx, finance, run, [delta("rolled back")]);
        await tx.execute(sql`SELECT pg_sleep(0.05)`);
        tx.rollback();
      }).catch(() => undefined);
      await new Promise((r) => setTimeout(r, 100));
      expect(heard).toEqual([]);
      await appendRunEvents(fx.db, finance, run, [delta("a"), delta("b")]);
      // Notifications arrive in commit order, so once the committed one is here, the rolled-back
      // one would have arrived before it: exactly one means it never did.
      await expect.poll(() => heard.length).toBeGreaterThan(0);
      expect(heard).toEqual([`${run}:2`]);
      expect(await fx.seqsInDb(finance, run)).toEqual([1, 2]);
    } finally {
      await listener.end();
    }
  });
});

describe("GET /v1/runs/{id}/events (ac-3)", () => {
  it("streams with SSE headers, retry first, frames per §6.2, and closes after the terminal event", async () => {
    const run = await fx.run(finance, alice);
    await appendRunEvents(fx.db, finance, run, [delta("one"), delta("two")]);
    const res = await fx.open(0, alice, run);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/event-stream; charset=utf-8");
    expect(res.headers.get("cache-control")).toBe("no-cache");
    expect(res.headers.get("x-accel-buffering")).toBe("no");
    const reader = new SseReader(res.body);
    expect((await reader.next())?.retry).toBe(2_000);
    const frame = await reader.next();
    expect(frame?.id).toBe("1");
    expect(frame?.event).toBe("text.delta");
    expect(JSON.parse(frame?.data ?? "")).toMatchObject({
      run_id: run,
      seq: 1,
      type: "text.delta",
      payload: { message_id: "m1", content_index: 0, delta: "one" },
    });
    expect((await reader.nextEvent())?.seq).toBe(2);
    await fx.complete(finance, run);
    expect(seqs(await reader.rest())).toEqual([3]);
  });

  it("resumes from max(starting_after, Last-Event-ID) and rejects malformed cursors", async () => {
    const run = await fx.run(finance, alice);
    await appendRunEvents(
      fx.db,
      finance,
      run,
      range(1, 6).map((i) => delta(String(i))),
    );
    await fx.complete(finance, run);
    const read = async (opts: { lastEventId?: string; startingAfter?: string }) => {
      const res = await fx.open(1, alice, run, opts);
      return seqs(await new SseReader(res.body).rest());
    };
    expect(await read({ startingAfter: "2" })).toEqual([3, 4, 5, 6, 7]);
    expect(await read({ startingAfter: "2", lastEventId: "5" })).toEqual([6, 7]);
    expect(await read({ startingAfter: "5", lastEventId: "1" })).toEqual([6, 7]);
    for (const bad of ["-1", "abc", "1.5", "01", "99999999999999999"]) {
      const res = await fx.open(0, alice, run, { startingAfter: bad });
      expect(res.status).toBe(400);
      expect(await res.json()).toMatchObject({ code: "invalid_cursor" });
    }
    expect((await fx.open(0, alice, run, { lastEventId: "x" })).status).toBe(400);
  });

  it("refuses a cursor beyond the run's last seq, including beyond int4, without a reconnect loop (review MEDIUM-2)", async () => {
    const run = await fx.run(finance, alice);
    await appendRunEvents(fx.db, finance, run, [delta("x"), delta("y")]);
    for (const cursor of ["3", "2147483648", "9007199254740991"]) {
      const res = await fx.open(0, alice, run, { startingAfter: cursor });
      expect(res.status, cursor).toBe(400);
      expect(await res.json()).toMatchObject({ code: "invalid_cursor" });
    }
    expect((await fx.open(0, alice, run, { startingAfter: "2" })).status).toBe(200);
    // The reader itself takes any safe-integer cursor (bigint comparison).
    const page = await fx.replica(0).deps.eventStream.reader.readPage(finance, run, 2 ** 40);
    expect(page).toMatchObject({ run: { lastSeq: 2 }, events: [] });
    await fx.complete(finance, run);
    expect((await fx.open(0, alice, run, { lastEventId: "2147483648" })).status).toBe(204);
  });

  it("coalesces concurrent reads of one run and reads on the stream pool, not the API pool (review MEDIUM-3)", async () => {
    const run = await fx.run(finance, alice);
    await appendRunEvents(fx.db, finance, run, [delta("x")]);
    const reader = fx.replica(0).deps.eventStream.reader;
    const a = reader.readPage(finance, run, 0);
    const b = reader.readPage(finance, run, 0);
    expect(a).toBe(b);
    expect((await a).events).toHaveLength(1);
    expect(reader.readPage(finance, run, 0)).not.toBe(a); // finished reads are not cached
    const { rows } = await fx.admin.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM pg_stat_activity
        WHERE datname = current_database() AND application_name = 'kobe-event-stream'`,
    );
    expect(rows[0]?.n).toBeGreaterThan(0);
  });

  it("answers 204 for an ended run with nothing after the cursor", async () => {
    const run = await fx.run(finance, alice);
    await appendRunEvents(fx.db, finance, run, [delta("x")]);
    await fx.complete(finance, run);
    const res = await fx.open(0, alice, run, { lastEventId: "2" });
    expect(res.status).toBe(204);
    expect(await res.text()).toBe("");
  });

  it("answers 410 events_compacted for a compacted run, whatever the cursor", async () => {
    const run = await fx.run(finance, alice);
    await fx.complete(finance, run);
    await fx.admin.query(
      `UPDATE runs SET events_compacted_at = now() WHERE team_id = $1 AND id = $2`,
      [finance, run],
    );
    for (const lastEventId of ["0", "1", "5"]) {
      const res = await fx.open(0, alice, run, { lastEventId });
      expect(res.status).toBe(410);
      expect(await res.json()).toMatchObject({ error: { code: "events_compacted" } });
    }
  });

  it("delivers live events from another replica through NOTIFY, not polling (ac-2, ac-7)", async () => {
    const run = await fx.run(finance, alice);
    const onB = await fx.stream(1, alice, run);
    const onA = await fx.stream(0, alice, run);
    await onB.next(); // retry
    await onA.next();
    for (let i = 1; i <= 5; i++) {
      const started = Date.now();
      // Append through replica 0's pool; both replicas' streams must see it well before keep-alive.
      await appendRunEvents(fx.replica(i % 2).deps.database.db, finance, run, [delta(String(i))]);
      expect((await onB.nextEvent())?.seq).toBe(i);
      expect((await onA.nextEvent())?.seq).toBe(i);
      expect(Date.now() - started).toBeLessThan(2_000);
    }
    await fx.complete(finance, run);
    expect(seqs(await onA.rest())).toEqual([6]);
    expect(seqs(await onB.rest())).toEqual([6]);
  });

  it("resumes gapless and duplicate-free after disconnects at random points under concurrent appends (U4, Gate 1)", async () => {
    const random = seededRandom("random-resume");
    const run = await fx.run(finance, alice);
    const writers = range(1, 3).map(async (w) => {
      for (let i = 0; i < 40; i++) {
        const n = 1 + Math.floor(random() * 6);
        await appendRunEvents(
          fx.replica(w % 2).deps.database.db,
          finance,
          run,
          range(1, n).map(() => delta(`w${w}-${i}`, `w${w}`)),
        );
        if (random() < 0.3) await new Promise((r) => setTimeout(r, random() * 10));
      }
    });
    const done = Promise.all(writers).then(() => fx.complete(finance, run));

    const received: KobeEvent[] = [];
    let reconnects = 0;
    for (;;) {
      const last = received.at(-1)?.seq ?? 0;
      const res = await fx.open(reconnects % 2, alice, run, { lastEventId: String(last) });
      if (res.status === 204) break;
      expect(res.status).toBe(200);
      const reader = new SseReader(res.body);
      const take = 1 + Math.floor(random() * 40);
      let ended = false;
      for (let i = 0; i < take; i++) {
        const e = await reader.nextEvent();
        if (!e) {
          ended = true;
          break;
        }
        received.push(e);
      }
      await reader.cancel(); // "refresh" mid-run
      reconnects += 1;
      if (ended && received.at(-1)?.type === "run.completed") break;
    }
    await done;
    const inDb = await fx.seqsInDb(finance, run);
    expect(seqs(received), `KOBE_TEST_SEED=${random.seed}`).toEqual(inDb);
    expect(inDb).toEqual(range(1, inDb.length));
    expect(received.at(-1)?.type).toBe("run.completed");
    expect(reconnects).toBeGreaterThan(3);
  });
});

describe("authorization (ac-4)", () => {
  it("gives the same 404 for unknown, other-team and teammates' runs", async () => {
    const run = await fx.run(finance, alice);
    await appendRunEvents(fx.db, finance, run, [delta("secret")]);
    const marketingRun = await fx.run(marketing, mallory);
    const bodies: unknown[] = [];
    for (const [who, id] of [
      [alice, randomUUID()],
      [alice, "not-a-uuid"],
      [alice, marketingRun], // exists, but in another team
      [mallory, run], // other team
      [bob, run], // teammate, private thread
      [fran, run], // team admin: cannot read members' threads
    ] as const) {
      const res = await fx.open(0, who, id);
      expect(res.status, `${who.email} ${id}`).toBe(404);
      bodies.push(await res.json());
    }
    expect(new Set(bodies.map((b) => JSON.stringify(b))).size).toBe(1);
  });

  it("requires a session and an active team", async () => {
    const run = await fx.run(finance, alice);
    const anon = await fx.replica(0).app.request(`http://kobe.test/v1/runs/${run}/events`);
    expect(anon.status).toBe(401);
    const loner = await fx.person("loner");
    expect((await fx.open(0, loner, run)).status).toBe(409); // no_active_team
  });

  it("ends a live stream when the member is removed from the team", async () => {
    const carl = await fx.person("carl");
    await fx.addMember(finance, carl);
    await fx.activate(carl, finance);
    const run = await fx.run(finance, carl);
    const reader = await fx.stream(2, carl, run);
    await reader.next();
    const res = await fran.browser.delete(`/v1/team/members/${carl.id}`);
    expect(res.status).toBe(204);
    const started = Date.now();
    expect(await reader.rest()).toEqual([]);
    expect(Date.now() - started).toBeLessThan(3_000);
  });

  it("ends a live stream when the session is revoked", async () => {
    const dana = await fx.person("dana");
    await fx.addMember(finance, dana);
    await fx.activate(dana, finance);
    const run = await fx.run(finance, dana);
    const reader = await fx.stream(2, dana, run);
    await reader.next();
    await fx.replica(0).deps.revokeAllSessions(dana.id);
    expect(await reader.rest()).toEqual([]);
  });

  it("caps concurrent streams per user on a replica and frees slots on disconnect (ac-6)", async () => {
    const run = await fx.run(finance, alice);
    const a = await fx.stream(2, alice, run);
    const b = await fx.stream(2, alice, run);
    const third = await fx.open(2, alice, run);
    expect(third.status).toBe(429);
    expect(await third.json()).toMatchObject({ code: "too_many_streams" });
    await a.cancel();
    const c = await fx.stream(2, alice, run);
    await b.cancel();
    await c.cancel();
  });
});

describe("delta batching end to end (ac-8)", () => {
  it("writes far fewer rows than deltas and keeps the text intact", async () => {
    const run = await fx.run(finance, alice);
    const batcher = createRunEventBatcher({
      write: async (events) => {
        await appendRunEvents(fx.db, finance, run, events);
      },
      windowMs: 50,
    });
    const words = range(1, 400).map((i) => `w${i} `);
    for (const w of words) {
      await batcher.push(delta(w));
      if (Math.random() < 0.05) await new Promise((r) => setTimeout(r, 20));
    }
    await batcher.push({ type: "run.completed", payload: { leaf_entry_id: null } });
    await batcher.close();
    const { rows } = await fx.admin.query<{ type: string; payload: { delta?: string } }>(
      `SELECT type, payload FROM run_events WHERE team_id = $1 AND run_id = $2 ORDER BY seq`,
      [finance, run],
    );
    expect(rows.length).toBeLessThan(60);
    expect(rows.at(-1)?.type).toBe("run.completed");
    expect(
      rows
        .filter((r) => r.type === "text.delta")
        .map((r) => r.payload.delta)
        .join(""),
    ).toBe(words.join(""));
  });
});
