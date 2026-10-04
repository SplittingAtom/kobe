import { randomBytes, randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { SANDBOX_CLOSE_CODES } from "@kobe/protocol";
import { SYSTEM_ACTOR, runs, threads, withTeam } from "@kobe/db";
import { recordAuditAfter } from "./audit/record.js";
import { IsolationRuntimeMissingError } from "./isolation/gate.js";
import {
  createDeferredWaker,
  createSandboxLifecycle,
  type LifecycleProvider,
  type SandboxLifecycle,
} from "./sandbox-lifecycle/index.js";
import type { HibernateOutcome, WakeResult } from "./sandbox/provider.js";
import { EventStreamFixture, must, type Person } from "./testing/event-stream-fixture.js";
import { FakeSandbox, FakeSandboxAuth, isFake, sandboxListener } from "./testing/fake-sandbox.js";

/**
 * Hibernation and wake (KOBE-25, D14) against a real Postgres, real WebSockets and two server
 * replicas: idle policy, busy checks, the wake path (router → waker → provider), and the races
 * (two replicas hibernating, wake racing hibernate, a pod on its way out reconnecting).
 */

/** A provider double recording the Kubernetes side; calls can be held open to force races. */
class FakeProvider implements LifecycleProvider {
  readonly calls: string[] = [];
  readonly state = new Map<string, "running" | "suspended">();
  readonly ids = new Map<string, string>();
  hold: Promise<void> | undefined;
  wakeError: Error | undefined;
  /** Transient failures (e.g. API timeouts) to throw before wakes succeed. */
  transientFailures = 0;
  /** The next hibernate finds the claim gone. */
  claimGone = false;

  sandboxIdOf(userId: string): string {
    let id = this.ids.get(userId);
    if (!id) {
      id = randomUUID();
      this.ids.set(userId, id);
    }
    return id;
  }

  async wakeSandbox(team: { id: string }, userId: string): Promise<WakeResult> {
    this.calls.push(`wake:${userId}`);
    if (this.wakeError) throw this.wakeError;
    if (this.transientFailures > 0) {
      this.transientFailures -= 1;
      throw new Error("Kubernetes API get SandboxClaim timed out after 10000 ms");
    }
    const resumed = this.state.get(userId) === "suspended";
    this.state.set(userId, "running");
    const sandboxId = this.sandboxIdOf(userId);
    // Like the real provider: audited once the resume is committed.
    if (resumed) {
      await recordAuditAfter(fx.db, {
        action: "sandbox.woken",
        actor: SYSTEM_ACTOR,
        teamId: team.id,
        target: { sandboxId, userId },
      });
    }
    return {
      resumed,
      handle: {
        sandboxId,
        namespace: `kobe-team-${team.id.slice(0, 4)}`,
        claimName: `u-${userId}`,
        sandboxName: `u-${userId}`,
        state: "running",
        podName: `u-${userId}`,
      },
    };
  }

  async hibernateSandbox(
    _team: unknown,
    userId: string,
    sandboxId: string,
  ): Promise<HibernateOutcome> {
    this.calls.push(`hibernate:${userId}`);
    await this.hold;
    if (this.claimGone) {
      this.claimGone = false;
      return "not_found";
    }
    if (this.ids.get(userId) !== sandboxId) return "not_found";
    this.state.set(userId, "suspended");
    return "suspended";
  }
}

const fx = new EventStreamFixture();
const auth = new FakeSandboxAuth();
const provider = new FakeProvider();
const wakers = [createDeferredWaker(), createDeferredWaker()];
const lifecycles: SandboxLifecycle[] = [];
const listeners: Awaited<ReturnType<typeof sandboxListener>>[] = [];
const sockets: FakeSandbox[] = [];

beforeAll(async () => {
  await fx.setup([{}, {}], (i) => ({
    sandboxWire: {
      sweep: false,
      tuning: {
        resultPollMs: 100,
        helloTimeoutMs: 1_000,
        wakeRetryBaseMs: 50,
        wakeRetryBudgetMs: 2_000,
      },
      waker: must(wakers[i], "waker"),
    },
  }));
  for (const i of [0, 1]) {
    const lifecycle = createSandboxLifecycle({ db: fx.db, provider, idleMinutes: 15 });
    lifecycles.push(lifecycle);
    must(wakers[i], "waker").set(lifecycle.waker);
    listeners.push(await sandboxListener(fx.replica(i).deps, auth));
  }
});

afterAll(async () => {
  for (const s of sockets) s.close();
  for (const l of listeners) await l.close();
  await fx.teardown();
});

beforeEach(() => {
  provider.calls.length = 0;
  provider.hold = undefined;
  provider.wakeError = undefined;
  provider.transientFailures = 0;
  provider.claimGone = false;
});

interface World {
  readonly team: string;
  readonly owner: Person;
  readonly target: { teamId: string; userId: string };
  readonly threadId: string;
}

async function world(): Promise<World> {
  const owner = await fx.person(`h${randomBytes(2).toString("hex")}`);
  const team = await fx.team(`h-${randomBytes(3).toString("hex")}`, owner);
  const threadId = await withTeam(fx.db, team, async (tx) => {
    const [t] = await tx
      .insert(threads)
      .values({ teamId: team, ownerUserId: owner.id })
      .returning({ id: threads.id });
    return must(t, "thread").id;
  });
  return { team, owner, target: { teamId: team, userId: owner.id }, threadId };
}

const lifecycle = (i = 0) => must(lifecycles[i], "lifecycle");
const router = (i = 0) => fx.replica(i).deps.sandboxWire.router;

async function sandboxRow(w: World) {
  const { rows } = await fx.admin.query<{
    state: string;
    sandbox_id: string | null;
    pvc: string | null;
    last_active_at: Date;
  }>(
    `SELECT state, sandbox_id, pvc, last_active_at FROM sandboxes WHERE team_id = $1 AND user_id = $2`,
    [w.team, w.owner.id],
  );
  return rows[0];
}

async function idleFor(w: World, minutes: number): Promise<void> {
  await fx.admin.query(
    `UPDATE sandboxes SET last_active_at = now() - make_interval(mins => $3) WHERE team_id = $1 AND user_id = $2`,
    [w.team, w.owner.id, minutes],
  );
}

async function audits(w: World, action: string) {
  const { rows } = await fx.admin.query<{ target: Record<string, unknown>; actor_kind: string }>(
    `SELECT target, actor_kind FROM audit_log WHERE team_id = $1 AND action = $2 ORDER BY at`,
    [w.team, action],
  );
  return rows;
}

/** A sandbox that has been woken once (row + identity) and is connected to replica `holder`. */
async function awake(w: World, holder = 0): Promise<FakeSandbox> {
  await lifecycle().waker.wake(w.target);
  const sb = await connect(w, holder);
  // Registered (its FOR SHARE on the row released): a hibernation would SKIP LOCKED meanwhile.
  await sb.ready();
  return sb;
}

async function connect(w: World, replica = 0): Promise<FakeSandbox> {
  const sandboxId = provider.sandboxIdOf(w.owner.id);
  const token = auth.issue({ sandboxId, teamId: w.team, userId: w.owner.id });
  const sb = await FakeSandbox.connect(must(listeners[replica], "listener").url, token);
  if (!isFake(sb)) throw new Error(`upgrade refused: ${sb.status}`);
  sockets.push(sb);
  sb.hello(sandboxId);
  return sb;
}

const getState = (w: World) =>
  router(1).piCommand(
    w.target,
    { threadId: w.threadId, command: { id: "x", type: "get_state" } },
    { timeoutMs: 8_000 },
  );

describe("hibernation policy (D14)", () => {
  it("hibernates a sandbox idle for its team's idle time and closes its connection `hibernating`", async () => {
    const w = await world();
    const sb = await awake(w);
    await sb.ready();
    await idleFor(w, 16);
    const result = await lifecycle().sweep();
    expect(result.hibernated).toContainEqual(w.target);
    expect(provider.calls).toContain(`hibernate:${w.owner.id}`);
    expect(await sandboxRow(w)).toMatchObject({ state: "hibernated" });
    expect((await sb.waitClosed()).code).toBe(SANDBOX_CLOSE_CODES.hibernating);
    const [audit] = await audits(w, "sandbox.hibernated");
    expect(audit).toMatchObject({
      actor_kind: "system",
      target: {
        sandboxId: provider.sandboxIdOf(w.owner.id),
        userId: w.owner.id,
        idleMinutes: 15,
        trigger: "idle",
      },
    });
  });

  it("keeps a sandbox awake until its idle time has passed, honouring the team setting", async () => {
    const w = await world();
    await awake(w);
    await idleFor(w, 10);
    await lifecycle().sweep();
    expect(await sandboxRow(w)).toMatchObject({ state: "running" });
    await fx.admin.query(
      `UPDATE teams SET settings = '{"sandbox_idle_minutes": 5}' WHERE id = $1`,
      [w.team],
    );
    await lifecycle().sweep();
    expect(await sandboxRow(w)).toMatchObject({ state: "hibernated" });
    expect((await audits(w, "sandbox.hibernated"))[0]?.target).toMatchObject({ idleMinutes: 5 });
  });

  it("ignores an out-of-range team setting (never sooner than 5 minutes)", async () => {
    const w = await world();
    await awake(w);
    await fx.admin.query(
      `UPDATE teams SET settings = '{"sandbox_idle_minutes": 1}' WHERE id = $1`,
      [w.team],
    );
    await idleFor(w, 3);
    await lifecycle().sweep();
    expect(await sandboxRow(w)).toMatchObject({ state: "running" });
  });

  for (const status of ["queued", "running", "waiting_approval"] as const) {
    it(`never hibernates a sandbox with a ${status} run, however long it was idle`, async () => {
      const w = await world();
      await awake(w);
      await withTeam(fx.db, w.team, (tx) =>
        tx.insert(runs).values({
          teamId: w.team,
          threadId: w.threadId,
          trigger: "user",
          status,
          ...(status === "queued" ? { queuePos: 1 } : { startedAt: new Date() }),
        }),
      );
      await idleFor(w, 120);
      await lifecycle().sweep();
      expect(await lifecycle().hibernate(w.target, { force: true })).toBe(false);
      expect(await sandboxRow(w)).toMatchObject({ state: "running" });
      expect(provider.calls.filter((c) => c.startsWith("hibernate"))).toEqual([]);
    });
  }

  it("counts a run's end as activity", async () => {
    const w = await world();
    await awake(w);
    await withTeam(fx.db, w.team, (tx) =>
      tx.insert(runs).values({
        teamId: w.team,
        threadId: w.threadId,
        trigger: "user",
        status: "completed",
        startedAt: new Date(Date.now() - 3 * 3600_000),
        endedAt: new Date(Date.now() - 2 * 60_000),
      }),
    );
    await idleFor(w, 60);
    await lifecycle().sweep();
    expect(await sandboxRow(w)).toMatchObject({ state: "running" });
  });

  it("never hibernates while a command waits for or runs in the sandbox", async () => {
    const w = await world();
    const sb = await awake(w);
    await sb.ready();
    sb.autoAnswer = false; // the command stays delivered, unanswered
    const pending = getState(w);
    await sb.until(() => sb.frames("pi.command")[0]);
    await idleFor(w, 60);
    expect(await lifecycle().hibernate(w.target)).toBe(false);
    expect(await sandboxRow(w)).toMatchObject({ state: "running" });
    sb.result(must(sb.frames("pi.command")[0], "cmd").command_id, true, {});
    await expect(pending).resolves.toMatchObject({ ok: true });
  });

  it("a routed command is activity: it refreshes last_active_at", async () => {
    const w = await world();
    const sb = await awake(w);
    await sb.ready();
    await idleFor(w, 60);
    await expect(getState(w)).resolves.toMatchObject({ ok: true });
    const row = must(await sandboxRow(w), "row");
    expect(Date.now() - row.last_active_at.getTime()).toBeLessThan(60_000);
    await lifecycle().sweep();
    expect(await sandboxRow(w)).toMatchObject({ state: "running" });
  });

  it("two replicas sweeping at once hibernate a sandbox once", async () => {
    const w = await world();
    await awake(w);
    await idleFor(w, 30);
    const [a, b] = await Promise.all([lifecycle(0).sweep(), lifecycle(1).sweep()]);
    const mine = [...a.hibernated, ...b.hibernated].filter((t) => t.userId === w.owner.id);
    expect(mine).toHaveLength(1);
    expect(provider.calls.filter((c) => c === `hibernate:${w.owner.id}`)).toHaveLength(1);
    expect(await audits(w, "sandbox.hibernated")).toHaveLength(1);
  });
});

describe("adoption of sandboxes without a lifecycle row", () => {
  it("a sandbox that connects without ever being woken gets a row and is then hibernated when idle", async () => {
    const w = await world();
    const sb = await connect(w, 1);
    await sb.ready();
    expect(await sandboxRow(w)).toMatchObject({
      state: "running",
      sandbox_id: provider.sandboxIdOf(w.owner.id),
    });
    await idleFor(w, 30);
    await lifecycle().sweep();
    expect(await sandboxRow(w)).toMatchObject({ state: "hibernated" });
  });
});

describe("hibernation of a sandbox whose claim is gone", () => {
  it("records nothing as hibernated and forgets the stale sandbox id", async () => {
    const w = await world();
    await awake(w);
    provider.claimGone = true;
    expect(await lifecycle().hibernate(w.target, { force: true })).toBe(false);
    expect(await sandboxRow(w)).toMatchObject({ state: "running", sandbox_id: null, pvc: null });
    expect(await audits(w, "sandbox.hibernated")).toEqual([]);
    // A later sweep skips it (no claim recorded) until a wake records the current one.
    await idleFor(w, 60);
    await lifecycle().sweep();
    expect(await sandboxRow(w)).toMatchObject({ state: "running" });
  });

  it("an operator-forced hibernation is audited as such", async () => {
    const w = await world();
    await awake(w);
    expect(await lifecycle().hibernate(w.target, { force: true })).toBe(true);
    expect((await audits(w, "sandbox.hibernated"))[0]?.target).toMatchObject({
      trigger: "operator",
    });
  });
});

describe("wake (router → waker → provider)", () => {
  async function hibernated(w: World): Promise<void> {
    const sb = await awake(w);
    await sb.ready();
    expect(await lifecycle().hibernate(w.target, { force: true })).toBe(true);
    await sb.waitClosed();
  }

  it("a command for a hibernated sandbox wakes it and is delivered when it connects", async () => {
    const w = await world();
    await hibernated(w);
    provider.calls.length = 0;
    const result = getState(w);
    await expect.poll(() => provider.calls, { timeout: 5_000 }).toContain(`wake:${w.owner.id}`);
    expect(await sandboxRow(w)).toMatchObject({
      state: "running",
      sandbox_id: provider.sandboxIdOf(w.owner.id),
      pvc: `workspace-u-${w.owner.id}`,
    });
    const sb = await connect(w, 0);
    await sb.ready();
    await expect(result).resolves.toMatchObject({ ok: true });
    const [woken] = await audits(w, "sandbox.woken");
    expect(woken?.target).toEqual({
      sandboxId: provider.sandboxIdOf(w.owner.id),
      userId: w.owner.id,
    });
  });

  it("refuses a connection from a hibernated sandbox's pod (on its way out) with `hibernating`", async () => {
    const w = await world();
    await hibernated(w);
    const late = await connect(w, 1);
    expect((await late.waitClosed()).code).toBe(SANDBOX_CLOSE_CODES.hibernating);
    const { rows } = await fx.admin.query<{ open: boolean }>(
      `SELECT closed_at IS NULL AS open FROM sandbox_connections WHERE team_id = $1 AND user_id = $2`,
      [w.team, w.owner.id],
    );
    expect(rows[0]?.open).toBe(false);
  });

  it("wake racing hibernate: a command arriving mid-hibernation waits, then wakes the sandbox", async () => {
    const w = await world();
    const sb = await awake(w);
    await sb.ready();
    await idleFor(w, 30);
    let release!: () => void;
    provider.hold = new Promise<void>((r) => (release = r));
    provider.calls.length = 0;
    const hibernating = lifecycle(0).hibernate(w.target);
    await expect.poll(() => provider.calls).toContain(`hibernate:${w.owner.id}`);
    // The hibernator holds the row lock inside its Kubernetes call: this command's touch waits.
    const command = getState(w);
    await new Promise((r) => setTimeout(r, 200));
    expect(provider.calls).toEqual([`hibernate:${w.owner.id}`]);
    release();
    await expect(hibernating).resolves.toBe(true);
    await expect.poll(() => provider.calls, { timeout: 5_000 }).toContain(`wake:${w.owner.id}`);
    expect(provider.calls).toEqual([`hibernate:${w.owner.id}`, `wake:${w.owner.id}`]);
    expect(await sandboxRow(w)).toMatchObject({ state: "running" });
    // Never delivered to the old pod: it was closed `hibernating`.
    expect((await sb.waitClosed()).code).toBe(SANDBOX_CLOSE_CODES.hibernating);
    expect(sb.frames("pi.command")).toEqual([]);
    const next = await connect(w, 1);
    await next.ready();
    await expect(command).resolves.toMatchObject({ ok: true });
  });

  async function wakingEvents(w: World, runId: string) {
    const { rows } = await fx.admin.query<{ payload: { reason: string } }>(
      `SELECT payload FROM run_events WHERE team_id = $1 AND run_id = $2 AND type = 'sandbox.waking'`,
      [w.team, runId],
    );
    return rows.map((r) => r.payload);
  }

  const startRun = (w: World, runId: string, threadId: string) =>
    router(1).startRun(w.target, { runId, threadId, message: "hi" }, { timeoutMs: 1_500 });

  it("tells the run whose start woke a hibernated sandbox: sandbox.waking {hibernated}", async () => {
    const w = await world();
    await hibernated(w);
    const runId = await fx.run(w.team, w.owner);
    const { rows } = await fx.admin.query<{ thread_id: string }>(
      `SELECT thread_id FROM runs WHERE team_id = $1 AND id = $2`,
      [w.team, runId],
    );
    void startRun(w, runId, must(rows[0], "run").thread_id);
    await expect
      .poll(() => wakingEvents(w, runId), { timeout: 5_000 })
      .toEqual([{ reason: "hibernated" }]);
  });

  it("a first-ever sandbox is announced as first_start; a finished run is told nothing", async () => {
    const w = await world();
    const runId = await fx.run(w.team, w.owner);
    const { rows } = await fx.admin.query<{ thread_id: string }>(
      `SELECT thread_id FROM runs WHERE team_id = $1 AND id = $2`,
      [w.team, runId],
    );
    void startRun(w, runId, must(rows[0], "run").thread_id);
    await expect
      .poll(() => wakingEvents(w, runId), { timeout: 5_000 })
      .toEqual([{ reason: "first_start" }]);

    const w2 = await world();
    await hibernated(w2);
    const done = await fx.run(w2.team, w2.owner);
    await fx.complete(w2.team, done);
    provider.calls.length = 0;
    await lifecycle().waker.wake(w2.target, { runId: done });
    expect(provider.calls).toEqual([`wake:${w2.owner.id}`]);
    expect(await wakingEvents(w2, done)).toEqual([]);
  });

  it("concurrent wakes of one sandbox in one process call the provider once", async () => {
    const w = await world();
    await Promise.all([1, 2, 3].map(() => lifecycle().waker.wake(w.target)));
    expect(provider.calls.filter((c) => c === `wake:${w.owner.id}`)).toHaveLength(1);
  });

  it("fails the waiting command at once when isolation is missing (no waiting for its deadline)", async () => {
    const w = await world();
    await hibernated(w);
    provider.wakeError = new IsolationRuntimeMissingError("no gVisor");
    const started = Date.now();
    await expect(getState(w)).resolves.toMatchObject({
      ok: false,
      error: { code: "isolation_runtime_missing" },
    });
    expect(Date.now() - started).toBeLessThan(5_000);
  });

  it("retries a transient wake failure while the command waits, then delivers it", async () => {
    const w = await world();
    await hibernated(w);
    provider.calls.length = 0;
    provider.transientFailures = 2;
    const result = getState(w);
    await expect
      .poll(() => provider.calls.filter((c) => c === `wake:${w.owner.id}`).length, {
        timeout: 5_000,
      })
      .toBe(3);
    const sb = await connect(w, 0);
    await sb.ready();
    await expect(result).resolves.toMatchObject({ ok: true });
  });

  it("fails the command `sandbox_unavailable` once the wake retry budget is spent", async () => {
    const w = await world();
    await hibernated(w);
    provider.transientFailures = 1_000;
    const started = Date.now();
    await expect(getState(w)).resolves.toMatchObject({
      ok: false,
      error: { code: "sandbox_unavailable" },
    });
    // Within the 2 s budget (tuned for the test), well before the command's 8 s deadline.
    expect(Date.now() - started).toBeLessThan(5_000);
  });

  it("does not wake the sandbox of a user who left the team", async () => {
    const w = await world();
    await hibernated(w);
    await fx.admin.query(`DELETE FROM team_members WHERE team_id = $1 AND user_id = $2`, [
      w.team,
      w.owner.id,
    ]);
    provider.calls.length = 0;
    await expect(lifecycle().waker.wake(w.target)).rejects.toMatchObject({
      code: "sandbox_unavailable",
    });
    expect(provider.calls).toEqual([]);
  });
});
