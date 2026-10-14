import { randomBytes, randomUUID } from "node:crypto";
import { Writable } from "node:stream";
import { pino } from "pino";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createDb, type KobeDatabase } from "@kobe/db";
import { approvalKeyring } from "./approvals/index.js";
import { createPolicyEngine } from "./policy/engine.js";
import { createToolRegistry } from "./policy/registry.js";
import { createDbRuleSource, createDbSettingsSource } from "./policy/rule-store.js";
import { EventStreamFixture, must, type Person } from "./testing/event-stream-fixture.js";
import { FakeSandbox, FakeSandboxAuth, isFake, sandboxListener } from "./testing/fake-sandbox.js";

/**
 * The approval broker's retry of `#create` (KOBE-266), driven against Postgres: test triggers
 * raise a real 40P01 inside the broker's transaction on the first N attempts (a sequence counts
 * attempts, since everything else rolls back with them). One deadlock is retried and the approval
 * is created; a deadlock on every attempt ends in a deny (fail closed), each retry logged. An
 * `approval.rejected` audit row whose transaction deadlocked is still written by the retry.
 */
const fx = new EventStreamFixture();
const auth = new FakeSandboxAuth();
const listeners: Awaited<ReturnType<typeof sandboxListener>>[] = [];
const sandboxes: FakeSandbox[] = [];
const extraDbs: KobeDatabase[] = [];
const KEY = approvalKeyring("approval-key-for-tests-".padEnd(48, "k"));
const logLines: Record<string, unknown>[] = [];
const log = pino(
  { level: "debug" },
  new Writable({
    write(chunk: Buffer, _enc, done) {
      for (const line of chunk.toString("utf8").split("\n")) {
        if (line.trim() !== "") logLines.push(JSON.parse(line) as Record<string, unknown>);
      }
      done();
    },
  }),
);
const registry = createToolRegistry({ resolve: () => Promise.resolve(undefined) });

/** Deadlocks forced by the test triggers: the next `n` matching inserts raise 40P01. */
async function forceDeadlocks(table: "approvals" | "audit", n: number): Promise<void> {
  await fx.admin.query(`UPDATE kobe266_force SET n = $2 WHERE tbl = $1`, [table, n]);
  await fx.admin.query(`SELECT setval('kobe266_attempts_${table}', 1, false)`);
}

beforeAll(async () => {
  await fx.setup([{}, {}], () => {
    const database = createDb(fx.database.appUrl);
    extraDbs.push(database);
    return {
      approvalKeys: KEY,
      approvals: { pollMs: 100, log },
      sandboxWire: {
        sweep: false,
        tools: registry,
        engine: createPolicyEngine({
          rules: createDbRuleSource(database.db),
          settings: createDbSettingsSource(database.db, 0),
          registry,
        }),
        tuning: {
          batchWindowMs: 20,
          resultPollMs: 200,
          upgradeBurst: 1_000,
          upgradeRatePerSec: 100,
        },
      },
    };
  });
  listeners.push(await sandboxListener(fx.replica(0).deps, auth));
  // Test-only fault injection (superuser, this throwaway database only). Only tool call ids
  // starting with "force-" are affected.
  await fx.admin.query(`
    CREATE TABLE kobe266_force (tbl text PRIMARY KEY, n int NOT NULL);
    INSERT INTO kobe266_force VALUES ('approvals', 0), ('audit', 0);
    CREATE SEQUENCE kobe266_attempts_approvals;
    CREATE SEQUENCE kobe266_attempts_audit;
    CREATE FUNCTION kobe266_maybe_deadlock(tbl text) RETURNS void LANGUAGE plpgsql
      SECURITY DEFINER SET search_path = pg_catalog, public AS $$
    BEGIN
      IF nextval('kobe266_attempts_' || tbl) <= (SELECT n FROM kobe266_force WHERE kobe266_force.tbl = $1) THEN
        RAISE EXCEPTION 'forced deadlock (test)' USING ERRCODE = '40P01';
      END IF;
    END $$;
    CREATE FUNCTION kobe266_approvals() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      IF NEW.tool_call_id LIKE 'force-%' THEN PERFORM kobe266_maybe_deadlock('approvals'); END IF;
      RETURN NEW;
    END $$;
    CREATE FUNCTION kobe266_audit() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      IF NEW.action = 'approval.rejected' AND NEW.target ->> 'toolCallId' LIKE 'force-%' THEN
        PERFORM kobe266_maybe_deadlock('audit');
      END IF;
      RETURN NEW;
    END $$;
    CREATE TRIGGER kobe266_deadlock BEFORE INSERT ON approvals
      FOR EACH ROW EXECUTE FUNCTION kobe266_approvals();
    CREATE TRIGGER aaa_kobe266_deadlock BEFORE INSERT ON audit_log
      FOR EACH ROW EXECUTE FUNCTION kobe266_audit();`);
});

afterAll(async () => {
  for (const s of sandboxes) s.close();
  for (const l of listeners) await l.close();
  await fx.teardown();
  for (const d of extraDbs) await d.close();
});

beforeEach(async () => {
  logLines.length = 0;
  await forceDeadlocks("approvals", 0);
  await forceDeadlocks("audit", 0);
});

interface World {
  readonly team: string;
  readonly owner: Person;
  readonly runId: string;
  readonly threadId: string;
  readonly sb: FakeSandbox;
}

async function world(): Promise<World> {
  const owner = await fx.person(`r${randomBytes(2).toString("hex")}`);
  const team = await fx.team(`retry-${randomBytes(3).toString("hex")}`, owner);
  const runId = await fx.run(team, owner);
  const { rows } = await fx.admin.query<{ thread_id: string }>(
    `SELECT thread_id FROM runs WHERE team_id = $1 AND id = $2`,
    [team, runId],
  );
  const threadId = must(rows[0], "run").thread_id;
  const sandboxId = randomUUID();
  const sb = await FakeSandbox.connect(
    must(listeners[0], "listener").url,
    auth.issue({ sandboxId, teamId: team, userId: owner.id }),
  );
  if (!isFake(sb)) throw new Error(`upgrade refused: ${sb.status}`);
  sandboxes.push(sb);
  sb.hello(sandboxId);
  await sb.ready();
  const started = await fx
    .replica(1)
    .deps.sandboxWire.router.startRun(
      { teamId: team, userId: owner.id },
      { runId, threadId, message: "hello" },
    );
  expect(started).toEqual({ ok: true });
  const rule = await owner.browser.post("/v1/team/policy/rules", {
    effect: "ask",
    tool_glob: "bash",
  });
  expect(rule.status, JSON.stringify(rule.json)).toBe(201);
  return { team, owner, runId, threadId, sb };
}

let nextRequest = 0;
function check(w: World, toolCallId: string) {
  const requestId = `r${(nextRequest += 1)}`;
  w.sb.send({
    v: 1,
    type: "policy.check",
    request_id: requestId,
    run_id: w.runId,
    thread_id: w.threadId,
    tool_call_id: toolCallId,
    tool: "bash",
    input: { command: "ls" },
  });
  return {
    pending: () =>
      w.sb.until(() => w.sb.frames("policy.pending").find((f) => f.request_id === requestId)),
    result: () =>
      w.sb.until(() => w.sb.frames("policy.result").find((f) => f.request_id === requestId)),
  };
}

function retryLogs(msg: string) {
  return logLines.filter((l) => l.msg === msg).map((l) => ({ code: l.code, attempt: l.attempt }));
}

async function approvalCount(w: World): Promise<number> {
  const { rows } = await fx.admin.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM approvals WHERE team_id = $1 AND run_id = $2`,
    [w.team, w.runId],
  );
  return rows[0]?.n ?? 0;
}

describe("approval create retry (KOBE-266)", () => {
  it("a deadlock on the first attempt is retried, logged, and the approval is created", async () => {
    const w = await world();
    await forceDeadlocks("approvals", 1);
    const pending = await check(w, "force-once").pending();
    expect(pending.approval_id).toBeTruthy();
    expect(retryLogs("approval create deadlock; retrying")).toEqual([
      { code: "40P01", attempt: 1 },
    ]);
    expect(await approvalCount(w)).toBe(1);
  });

  it("a deadlock on every attempt ends in a deny (fail closed), each retry logged", async () => {
    const w = await world();
    await forceDeadlocks("approvals", 99);
    const result = await check(w, "force-always").result();
    expect(result.decision).toBe("deny");
    expect(result.decision === "deny" && result.message).toMatch(/Policy could not be evaluated/);
    expect(retryLogs("approval create deadlock; retrying")).toEqual([
      { code: "40P01", attempt: 1 },
      { code: "40P01", attempt: 2 },
    ]);
    expect(await approvalCount(w)).toBe(0);
    const { rows } = await fx.admin.query<{ status: string }>(
      `SELECT status FROM runs WHERE team_id = $1 AND id = $2`,
      [w.team, w.runId],
    );
    expect(rows[0]?.status).toBe("running");
  });

  it("an approval.rejected audit row whose transaction deadlocked is written by the retry", async () => {
    const w = await world();
    await check(w, "force-dup").pending();
    await forceDeadlocks("audit", 1);
    const replay = await check(w, "force-dup").result();
    expect(replay.decision === "deny" && replay.message).toMatch(/already asked/);
    expect(retryLogs("approval create deadlock; retrying")).toEqual([
      { code: "40P01", attempt: 1 },
    ]);
    const { rows } = await fx.admin.query<{ target: Record<string, unknown> }>(
      `SELECT target FROM audit_log WHERE team_id = $1 AND action = 'approval.rejected'`,
      [w.team],
    );
    expect(rows.map((r) => r.target)).toEqual([
      expect.objectContaining({ reason: "replayed_tool_call_id", toolCallId: "force-dup" }),
    ]);
  });
});
