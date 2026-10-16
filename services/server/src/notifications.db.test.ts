import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  listNotificationsResponseSchema,
  markNotificationsReadResponseSchema,
} from "@kobe/protocol";
import { withTeam } from "@kobe/db";
import {
  NOTIFICATION_EMAIL_MAX_ATTEMPTS,
  deliverNotificationEmails,
} from "./notifications/email.js";
import { notifyScheduledRunEndInTx } from "./notifications/record.js";
import { endRunInTx } from "./sandbox-wire/run-state.js";
import type { RunEnd } from "./sandbox-wire/types.js";
import {
  EventStreamFixture,
  PUBLIC_URL,
  must,
  type Person,
} from "./testing/event-stream-fixture.js";
import type { MemoryMailer } from "./testing/mailer.js";

/**
 * Scheduled-run notifications (KOBE-179, D32; contract in docs/ledger/KOBE-176.md): one in-app
 * notification per scheduled run end (in the run's transaction), an optional email through the
 * outbox (at least once, lease, backoff, give-up), the owner's list and mark-read API. Ids, kinds
 * and counts only: never prompt or output text.
 */
const fx = new EventStreamFixture();
const PROMPT = "SECRET-PROMPT summarise the payroll ledger";
const OUTPUT = "SECRET-OUTPUT the payroll total";

beforeAll(async () => {
  await fx.setup([{}]);
});

afterAll(async () => {
  await fx.teardown();
});

const deps = () => fx.replica(0).deps;
const mailer = () => deps().mailer as MemoryMailer;
const deliver = (team: string) => deliverNotificationEmails(deps(), team);

interface World {
  readonly team: string;
  readonly owner: Person;
  readonly mate: Person;
  readonly scheduleId: string;
}

/** A team with an owner (who has a schedule) and a teammate. */
async function world(opts: { notifyEmail?: boolean; teamName?: string } = {}): Promise<World> {
  const owner = await fx.person("owner");
  const mate = await fx.person("mate");
  const team = await fx.team(`n-${randomUUID().slice(0, 8)}`, owner, [mate]);
  if (opts.teamName) {
    await fx.admin.query(`UPDATE teams SET name = $2 WHERE id = $1`, [team, opts.teamName]);
  }
  const scheduleId = randomUUID();
  await fx.admin.query(
    `INSERT INTO schedules (team_id, id, user_id, agent_id, prompt, recurrence, tz, active,
                            next_due_at, notify_email)
     VALUES ($1, $2, $3, $4, $5, '{"kind":"daily","at":"09:00"}', 'Europe/Berlin', true, now(), $6)`,
    [team, scheduleId, owner.id, randomUUID(), PROMPT, opts.notifyEmail ?? false],
  );
  return { team, owner, mate, scheduleId };
}

/** A running run on a thread of the schedule (or a user run on it, or on a plain thread). */
async function running(
  w: World,
  trigger: "schedule" | "user" = "schedule",
): Promise<{ runId: string; threadId: string }> {
  const runId = await fx.run(w.team, w.owner);
  const { rows } = await fx.admin.query<{ thread_id: string }>(
    `UPDATE runs SET trigger = $2, input = $3 WHERE id = $1 RETURNING thread_id`,
    [runId, trigger, PROMPT],
  );
  const threadId = must(rows[0], "run").thread_id;
  await fx.admin.query(`UPDATE threads SET schedule_id = $2, title = $3 WHERE id = $1`, [
    threadId,
    w.scheduleId,
    PROMPT,
  ]);
  return { runId, threadId };
}

const end = (w: World, runId: string, how: RunEnd) =>
  withTeam(fx.db, w.team, (tx) => endRunInTx(tx, w.team, runId, how));

async function notificationsOf(team: string) {
  const { rows } = await fx.admin.query<{
    id: string;
    user_id: string;
    kind: string;
    schedule_id: string;
    thread_id: string;
    run_id: string;
    skipped_count: number | null;
  }>(
    `SELECT id, user_id, kind, schedule_id, thread_id, run_id, skipped_count
       FROM notifications WHERE team_id = $1 ORDER BY created_at, id`,
    [team],
  );
  return rows;
}

async function emailsOf(team: string) {
  const { rows } = await fx.admin.query<{
    id: string;
    status: string;
    attempts: number;
    last_error: string | null;
    lease_until: Date | null;
  }>(
    `SELECT id, status, attempts, last_error, lease_until FROM notification_emails
      WHERE team_id = $1 ORDER BY created_at`,
    [team],
  );
  return rows;
}

const failed: RunEnd = {
  status: "failed",
  error: { code: "pi_error", message: OUTPUT },
};

describe("a notification per scheduled run end (ac-1)", () => {
  it("succeeded, failed and interrupted runs notify the owner, in the run's transaction", async () => {
    const w = await world();
    const ok = await running(w);
    const bad = await running(w);
    const lost = await running(w);
    await end(w, ok.runId, { status: "completed" });
    await end(w, bad.runId, failed);
    await end(w, lost.runId, { status: "interrupted" });
    const rows = await notificationsOf(w.team);
    expect(rows.map((r) => [r.run_id, r.kind, r.user_id, r.thread_id, r.schedule_id])).toEqual([
      [ok.runId, "schedule.run.succeeded", w.owner.id, ok.threadId, w.scheduleId],
      [bad.runId, "schedule.run.failed", w.owner.id, bad.threadId, w.scheduleId],
      [lost.runId, "schedule.run.interrupted", w.owner.id, lost.threadId, w.scheduleId],
    ]);
  });

  it("a budget stop is a failure; skipped actions on a completed run are their own kind", async () => {
    const w = await world();
    const stopped = await running(w);
    await fx.admin.query(`UPDATE runs SET budget_stop_scope = 'user' WHERE id = $1`, [
      stopped.runId,
    ]);
    await end(w, stopped.runId, { status: "completed" });
    const skipped = await running(w);
    for (const call of ["c1", "c2", "c3"]) {
      await fx.admin.query(
        `INSERT INTO run_skipped_actions (team_id, run_id, tool_call_id, tool, risk_class, reason)
         VALUES ($1, $2, $3, 'bash', 'destructive', 'scheduled_run_no_prompt')`,
        [w.team, skipped.runId, call],
      );
    }
    await end(w, skipped.runId, { status: "completed" });
    const rows = await notificationsOf(w.team);
    expect(rows.map((r) => [r.run_id, r.kind, r.skipped_count])).toEqual([
      [stopped.runId, "schedule.run.failed", null],
      [skipped.runId, "schedule.run.skipped_actions", 3],
    ]);
  });

  it("user-triggered runs, even in a scheduled thread, and cancelled runs do not notify", async () => {
    const w = await world({ notifyEmail: true });
    const reply = await running(w, "user");
    await end(w, reply.runId, { status: "completed" });
    // Deactivation and removal cancel scheduled runs (`system_cancelled`): no notification.
    const cancelled = await running(w);
    expect(await deps().runs.cancelScheduledRuns(w.team, w.owner.id, "owner_deactivated")).toEqual([
      cancelled.runId,
    ]);
    const status = await fx.admin.query(`SELECT status FROM runs WHERE id = $1`, [cancelled.runId]);
    expect(status.rows[0]).toEqual({ status: "cancelled" });
    expect(await notificationsOf(w.team)).toEqual([]);
    expect(await emailsOf(w.team)).toEqual([]);
  });

  it("a failing notify step never stops the run from ending (savepoint)", async () => {
    const w = await world({ notifyEmail: true });
    const r = await running(w);
    const fn = `fail_notify_${w.team.replaceAll("-", "")}`;
    await fx.admin.query(`
      CREATE FUNCTION ${fn}() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF NEW.team_id = '${w.team}' THEN RAISE EXCEPTION 'notify broken' USING ERRCODE = '40P01'; END IF;
        RETURN NEW;
      END $$;
      CREATE TRIGGER ${fn} BEFORE INSERT ON notifications FOR EACH ROW EXECUTE FUNCTION ${fn}();`);
    try {
      expect(await end(w, r.runId, { status: "completed" })).toMatchObject({ ended: true });
    } finally {
      await fx.admin.query(`DROP TRIGGER ${fn} ON notifications; DROP FUNCTION ${fn}();`);
    }
    const { rows } = await fx.admin.query(
      `SELECT r.status, (SELECT count(*)::int FROM run_events e
                          WHERE e.team_id = r.team_id AND e.run_id = r.id AND e.type = 'run.completed') AS n
         FROM runs r WHERE r.id = $1`,
      [r.runId],
    );
    expect(rows[0]).toEqual({ status: "completed", n: 1 });
    expect(await notificationsOf(w.team)).toEqual([]);
    expect(await emailsOf(w.team)).toEqual([]);
  });

  it("is idempotent per run (an at-least-once caller inserts once)", async () => {
    const w = await world({ notifyEmail: true });
    const r = await running(w);
    await end(w, r.runId, { status: "completed" });
    await withTeam(fx.db, w.team, (tx) =>
      notifyScheduledRunEndInTx(tx, {
        teamId: w.team,
        runId: r.runId,
        threadId: r.threadId,
        trigger: "schedule",
        to: "completed",
      }),
    );
    expect(await notificationsOf(w.team)).toHaveLength(1);
    expect(await emailsOf(w.team)).toHaveLength(1);
  });
});

describe("email through the outbox (ac-2)", () => {
  it("is sent once to the owner when notify_email is on; metadata only", async () => {
    const w = await world({ notifyEmail: true });
    const r = await running(w);
    await end(w, r.runId, failed);
    expect(await emailsOf(w.team)).toMatchObject([{ status: "pending", attempts: 0 }]);
    expect(await deliver(w.team)).toBe(1);
    expect(await deliver(w.team)).toBe(0);
    const sent = mailer().to(w.owner.email);
    expect(sent).toHaveLength(1);
    const mail = must(sent[0], "mail");
    expect(mail.subject).toMatch(/scheduled run failed/i);
    expect(mail.text).toContain(`${PUBLIC_URL}/?thread=${r.threadId}`);
    expect(mail.text).toContain("daily at 09:00 (Europe/Berlin)");
    expect(`${mail.subject}\n${mail.text}`).not.toMatch(/SECRET/);
    expect(mailer().to(w.mate.email)).toEqual([]);
    expect(await emailsOf(w.team)).toMatchObject([
      { status: "sent", attempts: 1, last_error: null, lease_until: null },
    ]);
  });

  it("is retried after an SMTP failure, and given up after the last attempt", async () => {
    const w = await world({ notifyEmail: true });
    const r = await running(w);
    await end(w, r.runId, { status: "completed" });
    mailer().failNext = new Error("421 try later");
    expect(await deliver(w.team)).toBe(0);
    expect(await emailsOf(w.team)).toMatchObject([
      { status: "pending", attempts: 1, last_error: "smtp_error", lease_until: null },
    ]);
    // Backoff: not due yet.
    expect(await deliver(w.team)).toBe(0);
    await fx.admin.query(
      `UPDATE notification_emails SET next_attempt_at = now() WHERE team_id = $1`,
      [w.team],
    );
    expect(await deliver(w.team)).toBe(1);
    expect(await emailsOf(w.team)).toMatchObject([{ status: "sent", attempts: 2 }]);

    const again = await running(w);
    await end(w, again.runId, { status: "completed" });
    await fx.admin.query(
      `UPDATE notification_emails SET attempts = $2 WHERE team_id = $1 AND status = 'pending'`,
      [w.team, NOTIFICATION_EMAIL_MAX_ATTEMPTS - 1],
    );
    mailer().failNext = new Error("554 rejected");
    expect(await deliver(w.team)).toBe(0);
    const rows = await emailsOf(w.team);
    expect(rows[1]).toMatchObject({
      status: "failed",
      attempts: NOTIFICATION_EMAIL_MAX_ATTEMPTS,
      last_error: "smtp_error",
    });
  });

  it("a row leased by another replica is left alone until the lease ends", async () => {
    const w = await world({ notifyEmail: true });
    const r = await running(w);
    await end(w, r.runId, { status: "completed" });
    await fx.admin.query(
      `UPDATE notification_emails SET lease_until = now() + interval '5 minutes' WHERE team_id = $1`,
      [w.team],
    );
    expect(await deliver(w.team)).toBe(0);
    await fx.admin.query(
      `UPDATE notification_emails SET lease_until = now() - interval '1 second' WHERE team_id = $1`,
      [w.team],
    );
    expect(await deliver(w.team)).toBe(1);
  });

  it("a replica whose lease ran out can neither send again nor overwrite the row", async () => {
    const w = await world({ notifyEmail: true });
    const r = await running(w);
    await end(w, r.runId, { status: "completed" });
    const m = mailer();
    const original = m.send.bind(m);
    let entered!: () => void;
    const inSend = new Promise<void>((resolve) => (entered = resolve));
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    // Replica A stalls in its send (a slow relay), then fails.
    m.send = async () => {
      m.send = original;
      entered();
      await gate;
      throw new Error("421 too late");
    };
    const a = deliver(w.team);
    await inSend;
    // A's lease runs out; replica B takes the row over and sends it.
    await fx.admin.query(
      `UPDATE notification_emails SET lease_until = now() - interval '1 second' WHERE team_id = $1`,
      [w.team],
    );
    expect(await deliver(w.team)).toBe(1);
    release();
    expect(await a).toBe(0);
    expect(await emailsOf(w.team)).toMatchObject([
      { status: "sent", attempts: 2, last_error: null, lease_until: null },
    ]);
    expect(mailer().to(w.owner.email)).toHaveLength(1);
  });

  it("a row at the attempt limit is given up, not claimed again", async () => {
    const w = await world({ notifyEmail: true });
    const r = await running(w);
    await end(w, r.runId, { status: "completed" });
    await fx.admin.query(`UPDATE notification_emails SET attempts = $2 WHERE team_id = $1`, [
      w.team,
      NOTIFICATION_EMAIL_MAX_ATTEMPTS,
    ]);
    expect(await deliver(w.team)).toBe(0);
    expect(await emailsOf(w.team)).toMatchObject([
      { status: "failed", attempts: NOTIFICATION_EMAIL_MAX_ATTEMPTS, last_error: "max_attempts" },
    ]);
    expect(mailer().to(w.owner.email)).toEqual([]);
  });

  it("email turned off after the run ended is not sent", async () => {
    const w = await world({ notifyEmail: true });
    const r = await running(w);
    await end(w, r.runId, { status: "completed" });
    await fx.admin.query(`UPDATE schedules SET notify_email = false WHERE id = $1`, [w.scheduleId]);
    expect(await deliver(w.team)).toBe(0);
    expect(await emailsOf(w.team)).toMatchObject([{ status: "skipped", last_error: "notify_off" }]);
  });

  it("nothing is queued when notify_email is off", async () => {
    const w = await world({ notifyEmail: false });
    const r = await running(w);
    await end(w, r.runId, { status: "completed" });
    expect(await notificationsOf(w.team)).toHaveLength(1);
    expect(await emailsOf(w.team)).toEqual([]);
  });

  it("a deactivated or removed owner is skipped", async () => {
    const w = await world({ notifyEmail: true });
    const r = await running(w);
    await end(w, r.runId, { status: "completed" });
    await fx.admin.query(`UPDATE users SET deactivated_at = now() WHERE id = $1`, [w.owner.id]);
    expect(await deliver(w.team)).toBe(0);
    expect(await emailsOf(w.team)).toMatchObject([
      { status: "skipped", last_error: "recipient_inactive" },
    ]);

    const v = await world({ notifyEmail: true });
    const s = await running(v);
    await end(v, s.runId, { status: "completed" });
    await fx.admin.query(`DELETE FROM team_members WHERE team_id = $1 AND user_id = $2`, [
      v.team,
      v.owner.id,
    ]);
    expect(await deliver(v.team)).toBe(0);
    expect(await emailsOf(v.team)).toMatchObject([
      { status: "skipped", last_error: "recipient_inactive" },
    ]);
    expect(mailer().to(w.owner.email)).toEqual([]);
    expect(mailer().to(v.owner.email)).toEqual([]);
  });

  it("names that try to break a header stay on one line", async () => {
    const w = await world({ notifyEmail: true, teamName: "Fin\r\nBcc: evil@x.test" });
    const r = await running(w);
    await end(w, r.runId, { status: "interrupted" });
    expect(await deliver(w.team)).toBe(1);
    const mail = must(mailer().to(w.owner.email)[0], "mail");
    expect(mail.subject).not.toMatch(/[\r\n]/);
    expect(mail.text).not.toMatch(/\nBcc:/);
  });
});

describe("the owner's list and mark read (ac-3)", () => {
  it("lists only the caller's notifications in the active team, newest first, with paging", async () => {
    const w = await world();
    const ended: string[] = [];
    for (let i = 0; i < 3; i++) {
      const r = await running(w);
      await end(w, r.runId, i === 1 ? failed : { status: "completed" });
      ended.push(r.runId);
    }
    const first = await w.owner.browser.get("/v1/notifications?limit=2");
    expect(first.status, JSON.stringify(first.json)).toBe(200);
    const page1 = listNotificationsResponseSchema.parse(first.json);
    expect(page1.unread_count).toBe(3);
    expect(page1.notifications.map((n) => n.run_id)).toEqual([ended[2], ended[1]]);
    expect(page1.next_cursor).not.toBeNull();
    const second = await w.owner.browser.get(
      `/v1/notifications?limit=2&cursor=${encodeURIComponent(String(page1.next_cursor))}`,
    );
    const page2 = listNotificationsResponseSchema.parse(second.json);
    expect(page2.notifications.map((n) => n.run_id)).toEqual([ended[0]]);
    expect(page2.next_cursor).toBeNull();
    expect(JSON.stringify([first.json, second.json])).not.toMatch(/SECRET/);

    // A teammate sees none of them; neither does a member of another team.
    const mate = listNotificationsResponseSchema.parse(
      (await w.mate.browser.get("/v1/notifications")).json,
    );
    expect(mate).toEqual({ notifications: [], unread_count: 0, next_cursor: null });
    const other = await world();
    const outsider = listNotificationsResponseSchema.parse(
      (await other.owner.browser.get("/v1/notifications")).json,
    );
    expect(outsider.notifications).toEqual([]);

    expect((await w.owner.browser.get("/v1/notifications?cursor=nope")).status).toBe(400);
    expect((await w.owner.browser.get("/v1/notifications?limit=101")).status).toBe(400);
  });

  it("marks read by id (own only) or all; unread filter and badge follow", async () => {
    const w = await world();
    for (let i = 0; i < 3; i++) {
      const r = await running(w);
      await end(w, r.runId, { status: "completed" });
    }
    const list = listNotificationsResponseSchema.parse(
      (await w.owner.browser.get("/v1/notifications")).json,
    );
    const [newest] = list.notifications;
    const id = must(newest, "notification").notification_id;

    // Someone else's id changes nothing.
    const foreign = await w.mate.browser.post("/v1/notifications/read", {
      notification_ids: [id],
    });
    expect(foreign.status).toBe(200);
    expect(markNotificationsReadResponseSchema.parse(foreign.json)).toEqual({
      updated: 0,
      unread_count: 0,
    });

    const one = await w.owner.browser.post("/v1/notifications/read", { notification_ids: [id] });
    expect(one.json).toEqual({ updated: 1, unread_count: 2 });
    const twice = await w.owner.browser.post("/v1/notifications/read", { notification_ids: [id] });
    expect(twice.json).toEqual({ updated: 0, unread_count: 2 });

    const unread = listNotificationsResponseSchema.parse(
      (await w.owner.browser.get("/v1/notifications?unread=true")).json,
    );
    expect(unread.notifications.map((n) => n.notification_id)).not.toContain(id);
    expect(unread.notifications).toHaveLength(2);
    const all = listNotificationsResponseSchema.parse(
      (await w.owner.browser.get("/v1/notifications")).json,
    );
    expect(all.notifications.find((n) => n.notification_id === id)?.read_at).not.toBeNull();

    const rest = await w.owner.browser.post("/v1/notifications/read", { all: true });
    expect(rest.json).toEqual({ updated: 2, unread_count: 0 });
    const bad = await w.owner.browser.post("/v1/notifications/read", {
      all: true,
      notification_ids: [id],
    });
    expect(bad.status).toBe(400);
  });
});
