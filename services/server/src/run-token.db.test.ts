import { randomBytes, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { CAPABILITY_RUN_TOKEN } from "@kobe/protocol";
import { deriveRunTokenKey, verifyRunToken } from "@kobe/protocol/node";
import { EventStreamFixture, must, type Person } from "./testing/event-stream-fixture.js";
import { FakeSandbox, FakeSandboxAuth, isFake, sandboxListener } from "./testing/fake-sandbox.js";
import { withAppendTx } from "./event-stream/append.js";
import { createSandboxWire } from "./sandbox-wire/index.js";
import { endRunInTx } from "./sandbox-wire/run-state.js";
import { RUN_TOKEN_TTL_SECONDS } from "./sandbox-wire/constants.js";

/** KOBE-118: the server mints a run token at run.start (capable agents only) and revokes it at run end. */
const fx = new EventStreamFixture();
const auth = new FakeSandboxAuth();
const key = deriveRunTokenKey(new TextEncoder().encode("k".repeat(40)));
const sandboxes: FakeSandbox[] = [];
let listener: Awaited<ReturnType<typeof sandboxListener>>;

beforeAll(async () => {
  await fx.setup([{}], () => ({
    sandboxWire: {
      sweep: false,
      runTokenKey: key,
      tuning: { batchWindowMs: 20, resultPollMs: 200, lostGraceMs: 0, helloTimeoutMs: 1_000 },
    },
  }));
  listener = await sandboxListener(fx.replica(0).deps, auth);
});
afterAll(async () => {
  for (const s of sandboxes) s.close();
  await listener.close();
  await fx.teardown();
});

async function start(capabilities?: readonly string[]) {
  const owner: Person = await fx.person(`u${randomBytes(2).toString("hex")}`);
  const team = await fx.team(`t-${randomBytes(3).toString("hex")}`, owner);
  const runId = await fx.run(team, owner);
  const { rows } = await fx.admin.query<{ thread_id: string }>(
    `SELECT thread_id FROM runs WHERE team_id = $1 AND id = $2`,
    [team, runId],
  );
  const threadId = must(rows[0], "run").thread_id;
  const sandboxId = randomUUID();
  const sb = await FakeSandbox.connect(
    listener.url,
    auth.issue({ sandboxId, teamId: team, userId: owner.id }),
  );
  if (!isFake(sb)) throw new Error(`upgrade refused: ${sb.status}`);
  sandboxes.push(sb);
  sb.hello(sandboxId, [], "1.0.0", capabilities);
  await sb.ready();
  const out = await fx
    .replica(0)
    .deps.sandboxWire.router.startRun(
      { teamId: team, userId: owner.id },
      { runId, threadId, message: "hi" },
    );
  expect(out).toEqual({ ok: true });
  const frame = must(sb.frames("run.start")[0], "run.start frame");
  return { team, runId, sandboxId, frame };
}

const records = (team: string, runId: string) =>
  fx.admin.query<{ jti: string; revoked_at: Date | null; expires_at: Date; issued_at: Date }>(
    `SELECT jti, revoked_at, expires_at, issued_at FROM run_tokens WHERE team_id = $1 AND run_id = $2`,
    [team, runId],
  );

describe("run tokens at run.start and run end", () => {
  it("mints a verifiable token bound to the run and sandbox for a capable agent", async () => {
    const w = await start([CAPABILITY_RUN_TOKEN]);
    const grant = must(w.frame.run_token, "run_token");
    const now = Math.floor(Date.now() / 1000);
    const verified = verifyRunToken(key, grant.token, now);
    expect(verified.ok).toBe(true);
    if (!verified.ok) return;
    expect(verified.claims).toMatchObject({
      run_id: w.runId,
      team_id: w.team,
      sandbox_id: w.sandboxId,
    });
    expect(verified.claims.exp - verified.claims.iat).toBe(RUN_TOKEN_TTL_SECONDS);
    const rows = (await records(w.team, w.runId)).rows;
    expect(rows.map((r) => r.jti)).toEqual([verified.claims.jti]);
    expect(rows[0]?.revoked_at).toBeNull();
  });

  it("sends nothing to an agent without the capability, and records nothing", async () => {
    const w = await start([]);
    expect(w.frame.run_token).toBeUndefined();
    expect((await records(w.team, w.runId)).rowCount).toBe(0);
  });

  it("revokes the run's tokens when the run ends", async () => {
    const w = await start([CAPABILITY_RUN_TOKEN]);
    await withAppendTx(fx.db, w.team, (tx) =>
      endRunInTx(tx, w.team, w.runId, { status: "completed" }),
    );
    const rows = (await records(w.team, w.runId)).rows;
    expect(rows).toHaveLength(1);
    expect(rows[0]?.revoked_at).not.toBeNull();
  });

  // Every way a run leaves the active statuses (user Stop, budget stop, approval expiry, start
  // failure, interrupt, lost sandbox, completion) is a status update on the runs row: one trigger.
  it.each(["completed", "failed", "interrupted", "cancelled", "budget_stopped"])(
    "revokes the run's tokens when its status becomes %s, by any path",
    async (status) => {
      const w = await start([CAPABILITY_RUN_TOKEN]);
      expect((await records(w.team, w.runId)).rows[0]?.revoked_at).toBeNull();
      await fx.admin.query(
        `UPDATE runs SET status = $3, ended_at = now() WHERE team_id = $1 AND id = $2`,
        [w.team, w.runId, status],
      );
      expect((await records(w.team, w.runId)).rows[0]?.revoked_at).not.toBeNull();
    },
  );

  it("keeps the tokens while the run only moves between active statuses", async () => {
    const w = await start([CAPABILITY_RUN_TOKEN]);
    await fx.admin.query(
      `UPDATE runs SET status = 'waiting_approval' WHERE team_id = $1 AND id = $2`,
      [w.team, w.runId],
    );
    expect((await records(w.team, w.runId)).rows[0]?.revoked_at).toBeNull();
  });
});

describe("run token TTL configuration", () => {
  it("fails fast on a TTL outside the contract's bounds", () => {
    for (const bad of [0, -5, 59, 24 * 3600 + 1, 1.5]) {
      expect(() =>
        createSandboxWire({
          db: fx.db,
          databaseUrl: "postgres://unused",
          runContext: {} as never,
          tuning: { runTokenTtlSeconds: bad },
        }),
      ).toThrow(/runTokenTtlSeconds/);
    }
  });
});
