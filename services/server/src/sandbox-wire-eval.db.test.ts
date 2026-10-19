import { randomBytes, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { SANDBOX_CLOSE_CODES } from "@kobe/protocol";
import { EventStreamFixture, must, type Person } from "./testing/event-stream-fixture.js";
import { FakeSandbox, FakeSandboxAuth, isFake, sandboxListener } from "./testing/fake-sandbox.js";

/**
 * KOBE-325: a member's own sandbox and the ephemeral sandboxes of their skill-eval threads on the
 * wire at once. Commands follow their thread in both directions, leases and `hello.ack` are per
 * sandbox (claim UID), an eval thread never wakes the member's sandbox, and a lost eval sandbox
 * never interrupts the member's runs (nor the reverse).
 */
const fx = new EventStreamFixture();
const auth = new FakeSandboxAuth();
const listeners: Awaited<ReturnType<typeof sandboxListener>>[] = [];
const woken: string[] = [];
const sandboxes: FakeSandbox[] = [];

beforeAll(async () => {
  await fx.setup([{}, {}], () => ({
    sandboxWire: {
      sweep: false,
      tuning: {
        batchWindowMs: 20,
        resultPollMs: 200,
        lostGraceMs: 0,
        helloTimeoutMs: 1_000,
        upgradeBurst: 1_000,
        upgradeRatePerSec: 100,
      },
      waker: { wake: (t) => Promise.resolve(void woken.push(t.userId)) },
    },
  }));
  listeners.push(await sandboxListener(fx.replica(0).deps, auth));
  listeners.push(await sandboxListener(fx.replica(1).deps, auth));
});

afterAll(async () => {
  for (const s of sandboxes) s.close();
  for (const l of listeners) await l.close();
  await fx.teardown();
});

const url = (replica: number) => must(listeners[replica], "listener").url;

interface Member {
  readonly team: string;
  readonly owner: Person;
}

async function member(): Promise<Member> {
  const owner = await fx.person(`e${randomBytes(2).toString("hex")}`);
  const team = await fx.team(`ev-${randomBytes(3).toString("hex")}`, owner);
  return { team, owner };
}

/** A thread with one running run: a normal one, or an eval thread. */
async function threadRun(
  m: Member,
  evalThread: boolean,
): Promise<{ threadId: string; runId: string }> {
  const threadId = randomUUID();
  await fx.admin.query(
    `INSERT INTO threads (team_id, id, owner_user_id, title, status, skill_eval)
     VALUES ($1, $2, $3, 't', 'running', $4)`,
    [m.team, threadId, m.owner.id, evalThread],
  );
  const { rows } = await fx.admin.query<{ id: string }>(
    `INSERT INTO runs (team_id, thread_id, trigger, status, started_at)
     VALUES ($1, $2, 'user', 'running', now()) RETURNING id`,
    [m.team, threadId],
  );
  return { threadId, runId: must(rows[0], "run").id };
}

async function connect(
  replica: number,
  m: Member,
  sandboxId: string,
  evalThreadId?: string,
): Promise<FakeSandbox> {
  const token = auth.issue({
    sandboxId,
    teamId: m.team,
    userId: m.owner.id,
    ...(evalThreadId ? { evalThreadId } : {}),
  });
  const sb = await FakeSandbox.connect(url(replica), token);
  if (!isFake(sb)) throw new Error(`upgrade refused: ${sb.status}`);
  sandboxes.push(sb);
  sb.hello(sandboxId, []);
  await sb.ready();
  return sb;
}

const target = (m: Member) => ({ teamId: m.team, userId: m.owner.id });
const starts = (sb: FakeSandbox) =>
  sb.frames("run.start").map((f) => (f as { run_id: string }).run_id);

async function leaseOf(m: Member, runId: string) {
  const { rows } = await fx.admin.query<{ slot: string; sandbox_id: string }>(
    `SELECT slot, sandbox_id FROM sandbox_run_leases WHERE team_id = $1 AND run_id = $2`,
    [m.team, runId],
  );
  return rows[0];
}

describe("eval sandboxes beside the member's own (KOBE-325)", () => {
  it("connects both at once, in their own rows; neither replaces the other", async () => {
    const m = await member();
    const ev = await threadRun(m, true);
    const own = await connect(0, m, randomUUID());
    const evalBox = await connect(1, m, randomUUID(), ev.threadId);
    expect(own.closed).toBeUndefined();
    expect(evalBox.closed).toBeUndefined();
    const conn = await fx.admin.query(
      `SELECT 1 FROM sandbox_connections WHERE team_id = $1 AND closed_at IS NULL`,
      [m.team],
    );
    const evalConn = await fx.admin.query<{ thread_id: string }>(
      `SELECT thread_id FROM sandbox_eval_connections WHERE team_id = $1 AND closed_at IS NULL`,
      [m.team],
    );
    expect(conn.rows.length).toBe(1);
    expect(evalConn.rows).toEqual([{ thread_id: ev.threadId }]);
  });

  it("sends an eval thread's run only to its eval sandbox and a normal run only to the member's", async () => {
    const m = await member();
    const normal = await threadRun(m, false);
    const ev = await threadRun(m, true);
    const ownId = randomUUID();
    const evalId = randomUUID();
    const own = await connect(0, m, ownId);
    const evalBox = await connect(0, m, evalId, ev.threadId);
    const router = fx.replica(1).deps.sandboxWire.router;
    expect(
      await router.startRun(target(m), { runId: ev.runId, threadId: ev.threadId, message: "e" }),
    ).toEqual({ ok: true });
    expect(
      await router.startRun(target(m), {
        runId: normal.runId,
        threadId: normal.threadId,
        message: "n",
      }),
    ).toEqual({ ok: true });
    expect(starts(evalBox)).toEqual([ev.runId]);
    expect(starts(own)).toEqual([normal.runId]);
    expect(await leaseOf(m, ev.runId)).toEqual({ slot: `e-${ev.threadId}`, sandbox_id: evalId });
    expect(await leaseOf(m, normal.runId)).toEqual({ slot: "", sandbox_id: ownId });
    // A caller naming the eval sandbox for another thread is refused.
    expect(
      await router.stopRun(
        { ...target(m), evalThreadId: ev.threadId },
        { runId: normal.runId, threadId: normal.threadId, mode: "abort", reason: "user_cancelled" },
      ),
    ).toMatchObject({ ok: false, error: { code: "thread_not_found" } });
  });

  it("never wakes the member's sandbox for an eval thread", async () => {
    const m = await member();
    const ev = await threadRun(m, true);
    const outcome = await fx.replica(0).deps.sandboxWire.router.startRun(
      target(m),
      {
        runId: ev.runId,
        threadId: ev.threadId,
        message: "e",
      },
      { timeoutMs: 1_500 },
    );
    expect(outcome.ok).toBe(false);
    expect(woken).not.toContain(m.owner.id);
  });

  it("an eval sandbox may not send frames for the member's run", async () => {
    const m = await member();
    const normal = await threadRun(m, false);
    const ev = await threadRun(m, true);
    await connect(0, m, randomUUID());
    const evalBox = await connect(1, m, randomUUID(), ev.threadId);
    expect(
      await fx.replica(0).deps.sandboxWire.router.startRun(target(m), {
        runId: normal.runId,
        threadId: normal.threadId,
        message: "n",
      }),
    ).toEqual({ ok: true });
    evalBox.event(normal.runId, normal.threadId, 1, { type: "agent_start" });
    expect((await evalBox.waitClosed()).code).toBe(SANDBOX_CLOSE_CODES.lease_violation);
  });

  it("does not list the member's runs in an eval sandbox's hello.ack, nor the reverse", async () => {
    const m = await member();
    const normal = await threadRun(m, false);
    const ev = await threadRun(m, true);
    const ownId = randomUUID();
    const evalId = randomUUID();
    const own = await connect(0, m, ownId);
    const evalBox = await connect(0, m, evalId, ev.threadId);
    const router = fx.replica(0).deps.sandboxWire.router;
    await router.startRun(target(m), {
      runId: normal.runId,
      threadId: normal.threadId,
      message: "n",
    });
    await router.startRun(target(m), { runId: ev.runId, threadId: ev.threadId, message: "e" });
    own.close();
    evalBox.close();
    const token = auth.issue({
      sandboxId: evalId,
      teamId: m.team,
      userId: m.owner.id,
      evalThreadId: ev.threadId,
    });
    const again = await FakeSandbox.connect(url(1), token);
    if (!isFake(again)) throw new Error("refused");
    sandboxes.push(again);
    again.hello(evalId, [
      { run_id: normal.runId, thread_id: normal.threadId, last_seq: 0 },
      { run_id: ev.runId, thread_id: ev.threadId, last_seq: 0 },
    ]);
    const ack = await again.ready();
    expect(ack.runs.map((r) => r.run_id)).toEqual([ev.runId]);
  });

  it("a gone eval sandbox interrupts only its own run; the member's keeps running", async () => {
    const m = await member();
    const normal = await threadRun(m, false);
    const ev = await threadRun(m, true);
    await connect(0, m, randomUUID());
    const evalBox = await connect(0, m, randomUUID(), ev.threadId);
    const router = fx.replica(0).deps.sandboxWire.router;
    await router.startRun(target(m), {
      runId: normal.runId,
      threadId: normal.threadId,
      message: "n",
    });
    await router.startRun(target(m), { runId: ev.runId, threadId: ev.threadId, message: "e" });
    evalBox.close();
    await expect
      .poll(async () => {
        const { rows } = await fx.admin.query(
          `SELECT 1 FROM sandbox_eval_connections WHERE team_id = $1 AND closed_at IS NOT NULL`,
          [m.team],
        );
        return rows.length;
      })
      .toBe(1);
    const result = await fx.replica(1).deps.sandboxWire.sweep();
    const ids = result.interrupted.map((r) => r.runId);
    expect(ids).toContain(ev.runId);
    expect(ids).not.toContain(normal.runId);
    const { rows } = await fx.admin.query<{ status: string }>(
      `SELECT status FROM runs WHERE team_id = $1 AND id = $2`,
      [m.team, normal.runId],
    );
    expect(rows[0]?.status).toBe("running");
  });
});
