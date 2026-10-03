import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { KobeEvent } from "@kobe/protocol";
import { must, type Person } from "./testing/event-stream-fixture.js";
import { RunFixture, piDelta, type FakeWorkspace, type RunWorld } from "./testing/run-fixture.js";
import type { SseReader } from "./testing/sse.js";

/**
 * Run orchestrator (KOBE-30) under concurrency, across two replicas on one database: racing
 * submissions, Stop racing the wire's own end and new messages, Trash racing a message, competing
 * promotions, and Gate 1 (two teams × five users chatting at once, refresh mid-run resumes
 * gapless; nobody reaches another user's run).
 */
const f = new RunFixture();

beforeAll(async () => {
  await f.setup();
});

afterAll(async () => {
  await f.teardown();
});

async function activeRuns(team: string, threadId: string): Promise<number> {
  const { rows } = await f.fx.admin.query(
    `SELECT 1 FROM runs WHERE team_id = $1 AND thread_id = $2
        AND status IN ('running', 'waiting_approval')`,
    [team, threadId],
  );
  return rows.length;
}

describe("racing submissions", () => {
  it("twelve messages at once on two replicas: one runs, eleven queue in distinct positions", async () => {
    const w = await f.world();
    const threadId = await f.thread(w.owner);
    const results = await Promise.all(
      Array.from({ length: 12 }, (_, i) => f.send(w.owner, threadId, `m${i}`, i % 2)),
    );
    expect(results.map((r) => r.status)).toEqual(Array(12).fill(201));
    expect(results.filter((r) => r.json.queued === false)).toHaveLength(1);
    expect(await activeRuns(w.team, threadId)).toBe(1);
    const list = await f.on(1, w.owner).get(`/v1/threads/${threadId}/runs`);
    const positions = (list.json.runs as { status: string; queue_pos?: number }[])
      .filter((r) => r.status === "queued")
      .map((r) => r.queue_pos);
    expect(positions).toEqual(Array.from({ length: 11 }, (_, i) => i + 1));
    // queue_pos stays unique among queued runs (KOBE-29 index) and run.queued said so too.
    const { rows } = await f.fx.admin.query<{ n: string }>(
      `SELECT count(DISTINCT queue_pos) AS n FROM runs
        WHERE team_id = $1 AND thread_id = $2 AND status = 'queued'`,
      [w.team, threadId],
    );
    expect(Number(must(rows[0], "count").n)).toBe(11);
  });

  it("two replicas promoting the same stalled queue start exactly one run", async () => {
    const w = await f.world();
    const threadId = await f.thread(w.owner);
    for (let i = 1; i <= 3; i += 1) {
      await f.fx.admin.query(
        `INSERT INTO runs (team_id, thread_id, trigger, status, queue_pos, input, created_at)
         VALUES ($1, $2, 'user', 'queued', $3, 'q', now() - interval '1 minute')`,
        [w.team, threadId, i],
      );
    }
    await Promise.all([f.fx.replica(0).deps.runs.sweep(), f.fx.replica(1).deps.runs.sweep()]);
    expect(await activeRuns(w.team, threadId)).toBe(1);
    const started = await f.fx.admin.query(
      `SELECT 1 FROM run_events e JOIN runs r ON r.team_id = e.team_id AND r.id = e.run_id
        WHERE r.team_id = $1 AND r.thread_id = $2 AND e.type = 'run.started'`,
      [w.team, threadId],
    );
    expect(started.rowCount).toBe(1);
  });
});

describe("Stop racing the wire and new messages", () => {
  it("each run ends exactly once and at most one run is ever active", async () => {
    const w = await f.world();
    const ws = await f.connect(w, 0);
    const threadId = await f.thread(w.owner);
    for (let round = 0; round < 6; round += 1) {
      const run = await f.message(w.owner, threadId, `round ${round}`);
      const start = await ws.started(run);
      ws.event(start, { type: "agent_start" });
      await ws.acked(run);
      // Pi settles (mirroring entries, thread lock first) while Stop and a new message race it.
      const [stop, next] = await Promise.all([
        f.on(1, w.owner).post(`/v1/runs/${run}/cancel`),
        f.send(w.owner, threadId, `after ${round}`, round % 2),
        Promise.resolve().then(() => ws.reply(start, "answer")),
      ]);
      expect([200, 409]).toContain(stop.status);
      expect(next.status).toBe(201);
      const nextId = next.json.run_id as string;
      await expect.poll(() => f.status(w.team, run)).toMatch(/^(cancelled|completed)$/);
      const types = await f.types(w.team, run);
      expect(types.filter((t) => t.startsWith("run.") && t !== "run.started")).toHaveLength(1);
      expect(["run.interrupted", "run.completed"]).toContain(types.at(-1));
      expect(await activeRuns(w.team, threadId)).toBeLessThanOrEqual(1);
      // The new message runs next; finish it so the thread is idle for the next round.
      ws.reply(await ws.started(nextId), "ok");
      await f.until(w.team, nextId, "completed");
    }
    expect(await f.threadStatus(w.team, threadId)).toBe("idle");
  });
});

describe("Trash racing a message (KOBE-34 requirement)", () => {
  it("never leaves a run on a trashed thread", async () => {
    const w = await f.world();
    for (let round = 0; round < 8; round += 1) {
      const threadId = await f.thread(w.owner);
      const [msg, trash] = await Promise.all([
        f.send(w.owner, threadId, "x", round % 2),
        f.on((round + 1) % 2, w.owner).delete(`/v1/threads/${threadId}`),
      ]);
      const { rows } = await f.fx.admin.query<{ deleted: boolean; pending: string }>(
        `SELECT t.deleted_at IS NOT NULL AS deleted,
                (SELECT count(*) FROM runs r WHERE r.team_id = t.team_id AND r.thread_id = t.id
                    AND r.status IN ('queued', 'running', 'waiting_approval')) AS pending
           FROM threads t WHERE t.team_id = $1 AND t.id = $2`,
        [w.team, threadId],
      );
      const row = must(rows[0], "thread");
      if (row.deleted) {
        expect(Number(row.pending)).toBe(0);
        expect(msg.status).toBe(409);
        expect(msg.json.code).toBe("thread_in_trash");
      } else {
        expect(msg.status).toBe(201);
        expect(trash.json.code).toBe("thread_busy");
        await f.on(0, w.owner).post(`/v1/runs/${msg.json.run_id as string}/cancel`);
      }
    }
  });
});

describe("Gate 1: two teams × five users chat concurrently", () => {
  interface Chat {
    readonly world: RunWorld;
    readonly person: Person;
    readonly ws: FakeWorkspace;
    readonly threadId: string;
  }

  async function readUntil(reader: SseReader, count: number): Promise<KobeEvent[]> {
    const out: KobeEvent[] = [];
    while (out.length < count) {
      const e = await reader.nextEvent();
      if (!e) break;
      out.push(e);
    }
    return out;
  }

  it(
    "each user gets exactly their own run, refresh mid-run resumes gapless, nobody reads another's",
    { timeout: 120_000 },
    async () => {
      // Two teams; in each, five users (the admin and four members), each with a sandbox.
      const chats: Chat[] = [];
      for (let t = 0; t < 2; t += 1) {
        const admin = await f.world();
        const people = [admin.owner];
        for (let i = 0; i < 4; i += 1) people.push(await f.member(admin.team));
        for (const [i, person] of people.entries()) {
          const world = {
            team: admin.team,
            owner: person,
            target: { teamId: admin.team, userId: person.id },
          };
          chats.push({
            world,
            person,
            ws: await f.connect(world, i % 2),
            threadId: await f.thread(person, i % 2),
          });
        }
      }
      // Everyone sends at once, through alternating replicas.
      const runIds = await Promise.all(
        chats.map((c, i) => f.message(c.person, c.threadId, `hello from ${i}`, (i + 1) % 2)),
      );
      const starts = await Promise.all(chats.map((c, i) => c.ws.started(must(runIds[i], "run"))));
      // First half of each answer streams; each user opens the stream and reads it.
      for (const [i, c] of chats.entries()) {
        const start = must(starts[i], "start");
        c.ws.event(start, { type: "agent_start" });
        c.ws.event(start, { type: "message_start", message: { role: "assistant" } });
        for (let k = 0; k < 5; k += 1) {
          c.ws.event(start, piDelta(`${i}:${k} `));
          c.ws.event(start, { type: "turn_end", message: { role: "assistant" } });
        }
      }
      await Promise.all(chats.map((c, i) => c.ws.acked(must(runIds[i], "run"))));
      const firstHalves = await Promise.all(
        chats.map(async (c, i) => {
          const reader = await f.fx.stream(i % 2, c.person, must(runIds[i], "run"));
          const got = await readUntil(reader, 2);
          await reader.cancel(); // the user refreshes the page mid-run
          return got;
        }),
      );
      // The rest of each answer arrives while nobody is connected.
      for (const [i, c] of chats.entries()) {
        c.ws.reply(must(starts[i], "start"), `rest of ${i}`);
      }
      const rest = await Promise.all(
        chats.map(async (c, i) => {
          const seen = must(firstHalves[i], "first half");
          const reader = await f.fx.stream(
            (i + 1) % 2,
            c.person,
            must(runIds[i], "run"),
            seen.at(-1)?.seq,
          );
          return reader.rest();
        }),
      );
      for (const [i, c] of chats.entries()) {
        const runId = must(runIds[i], "run");
        const all = [...must(firstHalves[i], "first"), ...must(rest[i], "rest")];
        expect(all.every((e) => e.run_id === runId)).toBe(true);
        const seqs = all.map((e) => e.seq);
        expect(seqs).toEqual(await f.fx.seqsInDb(c.world.team, runId));
        expect(seqs).toEqual(Array.from({ length: seqs.length }, (_, k) => k + 1));
        expect(all[0]?.type).toBe("run.started");
        expect(all.at(-1)?.type).toBe("run.completed");
        const text = all
          .filter((e) => e.type === "text.delta")
          .map((e) => (e.payload as { delta: string }).delta)
          .join("");
        expect(text).toContain(`${i}:0`);
      }
      // Nobody opens, steers, stops or retries anyone else's run.
      for (const [i, c] of chats.entries()) {
        const victim = must(runIds[(i + 3) % chats.length], "victim");
        expect((await f.fx.open(i % 2, c.person, victim)).status).toBe(404);
        expect((await f.on(i % 2, c.person).get(`/v1/runs/${victim}`)).status).toBe(404);
        expect((await f.on(i % 2, c.person).post(`/v1/runs/${victim}/cancel`)).status).toBe(404);
      }
    },
  );
});
