import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { CAPABILITY_RUN_TOKEN, CAPABILITY_THREAD_COMPACT } from "@kobe/protocol";
import { deriveRunTokenKey } from "@kobe/protocol/node";
import { auditQuerySchema, listAuditEvents, listTeamAuditEvents, withTeam } from "@kobe/db";
import { must } from "./testing/event-stream-fixture.js";
import { RunFixture, type FakeWorkspace, type RunWorld } from "./testing/run-fixture.js";
import { TAMPER_AUDIT_ATTEMPTS, auditRuntimeTamperInTx } from "./sandbox-wire/runtime-tamper.js";

/**
 * A tampered Pi runtime (KOBE-271) is a security event: the run's failure is recorded with an
 * audit row `sandbox.runtime_tampered` in the same transaction, for message runs (`run.start`
 * refused) and compaction runs (`thread.compact_result`), ids only, once per run, visible in the
 * site and team audit views and never erased with the client address (a system row has none).
 */
const f = new RunFixture();
const ACTION = "sandbox.runtime_tampered";
const CAPABLE = [
  "skill_bundles",
  "builtin_skills",
  CAPABILITY_RUN_TOKEN,
  CAPABILITY_THREAD_COMPACT,
];
const SANDBOX_TEXT = "agent/models.json changed by pid 4242";

beforeAll(async () => {
  await f.setup({ runTokenKey: deriveRunTokenKey(new TextEncoder().encode("t".repeat(40))) });
});
afterAll(async () => {
  await f.teardown();
});

const db = () => f.fx.replica(0).deps.database.db;

async function teamModel(w: RunWorld): Promise<void> {
  const admin = f.fx.admin;
  await admin.query(
    `INSERT INTO model_providers (id, kind, name, api_key_enc, created_by)
     VALUES ('openai', 'openai', 'openai', 'v2.test.sealed-provider-key', $1)
     ON CONFLICT (id) DO NOTHING`,
    [w.owner.id],
  );
  await admin.query(
    `INSERT INTO model_catalog (alias, provider_id, model, created_by)
     VALUES ('tamper-fast', 'openai', 'gpt-fake', $1) ON CONFLICT (alias) DO NOTHING`,
    [w.owner.id],
  );
  await admin.query(
    `INSERT INTO team_models (team_id, alias, is_default, enabled_by) VALUES ($1, 'tamper-fast', true, $2)`,
    [w.team, w.owner.id],
  );
}

/** The sandbox fails every `run.start` with `runtime_tampered`; other frames as usual. */
function tamperStarts(ws: FakeWorkspace): void {
  const base = ws.sb.respond;
  ws.sb.respond = (frame) =>
    frame.type === "run.start"
      ? {
          v: 1,
          type: "command.result",
          command_id: frame.command_id,
          ok: false,
          error: { code: "runtime_tampered", message: SANDBOX_TEXT },
        }
      : base?.(frame);
}

async function sandboxOf(w: RunWorld): Promise<string> {
  const { rows } = await f.fx.admin.query<{ sandbox_id: string }>(
    `SELECT sandbox_id FROM sandbox_connections WHERE team_id = $1 AND user_id = $2`,
    [w.team, w.owner.id],
  );
  return must(rows[0], "connection").sandbox_id;
}

async function tamperRows(team: string) {
  const { rows } = await f.fx.admin.query<{
    actor_kind: string;
    actor_id: string | null;
    target: Record<string, unknown>;
    ip: string | null;
    user_agent: string | null;
    pii_commitment: string | null;
  }>(
    `SELECT actor_kind, actor_id, target, ip, user_agent, pii_commitment FROM audit_log
      WHERE team_id = $1 AND action = $2 ORDER BY seq`,
    [team, ACTION],
  );
  return rows;
}

async function failureCode(team: string, runId: string): Promise<unknown> {
  const events = await f.events(team, runId);
  const last = events.at(-1) as { type: string; payload: { error?: { code?: string } } };
  expect(last.type).toBe("run.failed");
  return last.payload.error?.code;
}

/** Ids only: no reason, path or other text of the sandbox's. */
function expectIdsOnly(target: Record<string, unknown>): void {
  expect(Object.keys(target).sort()).toEqual(
    ["replicaId", "runId", "runKind", "sandboxId", "threadId", "userId"].sort(),
  );
  expect(JSON.stringify(target)).not.toContain("models.json");
}

/**
 * Makes `sandbox.runtime_tampered` inserts of `team` fail: the first `failures` of them, or every
 * one (null). `tries()` counts the inserts attempted; `drop()` removes the fault.
 */
async function failTamperInserts(team: string, failures: number | null) {
  const admin = f.fx.admin;
  await admin.query(
    `DROP SEQUENCE IF EXISTS kobe_test_tamper_tries; CREATE SEQUENCE kobe_test_tamper_tries`,
  );
  await admin.query(`
    CREATE OR REPLACE FUNCTION kobe_test_tamper_fault() RETURNS trigger
      LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
    BEGIN
      IF NEW.action = '${ACTION}' AND NEW.team_id = '${team}' THEN
        IF nextval('kobe_test_tamper_tries') <= ${failures ?? 1_000_000} THEN
          RAISE EXCEPTION 'test: audit insert refused';
        END IF;
      END IF;
      RETURN NEW;
    END $$`);
  await admin.query(`
    CREATE TRIGGER kobe_test_tamper_fault BEFORE INSERT ON audit_log
      FOR EACH ROW EXECUTE FUNCTION kobe_test_tamper_fault()`);
  return {
    tries: async () => {
      const { rows } = await admin.query<{ n: string }>(
        `SELECT CASE WHEN is_called THEN last_value ELSE 0 END AS n FROM kobe_test_tamper_tries`,
      );
      return Number(must(rows[0], "sequence").n);
    },
    drop: async () => {
      await admin.query(`DROP TRIGGER kobe_test_tamper_fault ON audit_log`);
      await admin.query(`DROP FUNCTION kobe_test_tamper_fault()`);
      await admin.query(`DROP SEQUENCE kobe_test_tamper_tries`);
    },
  };
}

describe("sandbox.runtime_tampered (KOBE-271)", () => {
  it("a message run refused for a tampered runtime is failed and audited once, ids only", async () => {
    const w = await f.world();
    await teamModel(w);
    const ws = await f.connect(w, 0, CAPABLE);
    tamperStarts(ws);
    const threadId = await f.thread(w.owner);
    const runId = await f.message(w.owner, threadId, "a prompt that must stay out of audit");
    await f.until(w.team, runId, "failed");
    expect(await failureCode(w.team, runId)).toBe("runtime_tampered");
    const rows = await tamperRows(w.team);
    expect(rows).toHaveLength(1);
    const row = must(rows[0], "row");
    expect(row).toMatchObject({ actor_kind: "system", actor_id: null });
    expect(row.target).toEqual({
      sandboxId: await sandboxOf(w),
      userId: w.owner.id,
      threadId,
      runId,
      runKind: "message",
      replicaId: f.fx.replica(0).deps.sandboxWire.replicaId,
    });
    expectIdsOnly(row.target);
    expect(JSON.stringify(row.target)).not.toContain("prompt");
    // A system row has no client address: nothing for the IP/UA erasure, the row is kept forever.
    expect(row).toMatchObject({ ip: null, user_agent: null, pii_commitment: null });
  });

  it("a compaction stopped for a tampered runtime is failed and audited once, ids only", async () => {
    const w = await f.world();
    await teamModel(w);
    const ws = await f.connect(w, 1, CAPABLE);
    const threadId = await f.thread(w.owner);
    const first = await f.message(w.owner, threadId, "first");
    ws.reply(await ws.started(first), "answer");
    await f.until(w.team, first, "completed");
    const pending = f.on(0, w.owner).post(`/v1/threads/${threadId}/compact`, {});
    const frame = await ws.compacting();
    ws.compacted(frame, { code: "runtime_tampered", message: SANDBOX_TEXT });
    expect((await pending).status).toBe(502);
    expect(await failureCode(w.team, frame.run_id)).toBe("runtime_tampered");
    const rows = await tamperRows(w.team);
    expect(rows).toHaveLength(1);
    const row = must(rows[0], "row");
    expect(row.target).toEqual({
      sandboxId: await sandboxOf(w),
      userId: w.owner.id,
      threadId,
      runId: frame.run_id,
      runKind: "compaction",
      replicaId: f.fx.replica(1).deps.sandboxWire.replicaId,
    });
    expectIdsOnly(row.target);
    expect(row).toMatchObject({ actor_kind: "system", ip: null, user_agent: null });
  });

  it("a duplicate report for the same run writes one row", async () => {
    const w = await f.world();
    await teamModel(w);
    const ws = await f.connect(w, 0, CAPABLE);
    tamperStarts(ws);
    const threadId = await f.thread(w.owner);
    const runId = await f.message(w.owner, threadId, "x");
    await f.until(w.team, runId, "failed");
    const report = {
      teamId: w.team,
      userId: w.owner.id,
      sandboxId: await sandboxOf(w),
      replicaId: f.fx.replica(1).deps.sandboxWire.replicaId,
      threadId,
      runId,
      runKind: "message" as const,
    };
    // The run's report came over the wire: a repeat (another replica, a re-delivery) adds none.
    const again = () => withTeam(db(), w.team, (tx) => auditRuntimeTamperInTx(tx, report));
    expect(await Promise.all([again(), again()])).toEqual([false, false]);
    expect(await tamperRows(w.team)).toHaveLength(1);
    // Another run of the thread is its own event.
    const next = await f.message(w.owner, threadId, "y");
    await f.until(w.team, next, "failed");
    expect((await tamperRows(w.team)).map((r) => r.target.runId)).toEqual([runId, next]);
  });

  it("two first reports of a run racing write one row", async () => {
    const w = await f.world();
    await teamModel(w);
    const ws = await f.connect(w, 0, CAPABLE);
    const threadId = await f.thread(w.owner);
    const runId = await f.message(w.owner, threadId, "x");
    ws.reply(await ws.started(runId), "answer");
    await f.until(w.team, runId, "completed");
    const report = {
      teamId: w.team,
      userId: w.owner.id,
      sandboxId: await sandboxOf(w),
      replicaId: f.fx.replica(0).deps.sandboxWire.replicaId,
      threadId,
      runId,
      runKind: "message" as const,
    };
    const once = () => withTeam(db(), w.team, (tx) => auditRuntimeTamperInTx(tx, report));
    const results = await Promise.all([once(), once(), once()]);
    expect(results.filter(Boolean)).toHaveLength(1);
    expect(await once()).toBe(false);
    expect(await tamperRows(w.team)).toHaveLength(1);
  });

  it("the run's failure and its row commit together: a refused audit write leaves neither", async () => {
    const w = await f.world();
    await teamModel(w);
    const ws = await f.connect(w, 0, CAPABLE);
    tamperStarts(ws);
    const faults = await failTamperInserts(w.team, null);
    try {
      const threadId = await f.thread(w.owner);
      const runId = await f.message(w.owner, threadId, "x");
      // The run end with its row, then the row alone on every retry: all refused.
      await expect
        .poll(() => faults.tries(), { timeout: 15_000, interval: 50 })
        .toBe(1 + TAMPER_AUDIT_ATTEMPTS);
      expect(await f.status(w.team, runId)).toBe("running");
      expect(await f.types(w.team, runId)).not.toContain("run.failed");
      expect(await tamperRows(w.team)).toEqual([]);
    } finally {
      await faults.drop();
    }
  });

  it("a run end that could not commit still leaves the row (written on its own)", async () => {
    const w = await f.world();
    await teamModel(w);
    const ws = await f.connect(w, 0, CAPABLE);
    tamperStarts(ws);
    // The first insert (with the run's failure) is refused; the retry writes the row alone.
    const faults = await failTamperInserts(w.team, 1);
    try {
      const threadId = await f.thread(w.owner);
      const runId = await f.message(w.owner, threadId, "x");
      await expect
        .poll(async () => (await tamperRows(w.team)).length, { timeout: 15_000, interval: 50 })
        .toBe(1);
      expect(must((await tamperRows(w.team))[0], "row").target).toMatchObject({
        runId,
        threadId,
        runKind: "message",
      });
      // The run's end rolled back; the lost-run sweep ends it later (unchanged).
      expect(await f.status(w.team, runId)).toBe("running");
      expect(await faults.tries()).toBe(2);
    } finally {
      await faults.drop();
    }
  });

  it("once per run even when the run row is gone (racing reports of a deleted run)", async () => {
    const w = await f.world();
    const report = {
      teamId: w.team,
      userId: w.owner.id,
      sandboxId: randomUUID(),
      replicaId: f.fx.replica(0).deps.sandboxWire.replicaId,
      threadId: randomUUID(),
      runId: randomUUID(),
      runKind: "message" as const,
    };
    const once = () => withTeam(db(), w.team, (tx) => auditRuntimeTamperInTx(tx, report));
    // The first report holds its transaction open after writing; the second starts meanwhile.
    let second: Promise<boolean> | undefined;
    const first = withTeam(db(), w.team, async (tx) => {
      const wrote = await auditRuntimeTamperInTx(tx, report);
      second = once();
      await new Promise((r) => setTimeout(r, 300));
      return wrote;
    });
    expect(await first).toBe(true);
    expect(await must(second, "second report")).toBe(false);
    expect(await tamperRows(w.team)).toHaveLength(1);
  });

  it("site admins find it by action in the site view; team admins in the team view", async () => {
    const w = await f.world();
    await teamModel(w);
    const ws = await f.connect(w, 0, CAPABLE);
    tamperStarts(ws);
    const threadId = await f.thread(w.owner);
    const runId = await f.message(w.owner, threadId, "x");
    await f.until(w.team, runId, "failed");
    const query = auditQuerySchema.parse({ action: ACTION, teamId: w.team });
    const site = await listAuditEvents(db(), query);
    expect(site.events.map((e) => [e.action, e.target.runId])).toEqual([[ACTION, runId]]);
    const team = await withTeam(db(), w.team, (tx) =>
      listTeamAuditEvents(tx, auditQuerySchema.parse({ action: ACTION })),
    );
    expect(team.events.map((e) => [e.action, e.target.runId])).toEqual([[ACTION, runId]]);
  });
});
