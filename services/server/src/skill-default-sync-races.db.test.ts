import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { logger } from "./logger.js";
import { defaultSyncOnce, queueDefaultSync } from "./skills/default-sync.js";
import type { TestBrowser } from "./testing/browser.js";
import { openHarness, type Harness } from "./testing/harness.js";

/**
 * KOBE-314 review: the Default sync under races and failures. Jobs run in commit order and act on
 * the tag's current state (a fast off-on toggle never installs a non-Default skill); an opt-out
 * racing a sync wins; blocked teams never get the skill; a failing job is retried with backoff,
 * then parked as `failed` while the queue moves on.
 */
let h: Harness;
const team = { finance: randomUUID(), legal: randomUUID(), ops: randomUUID() };
const ids = { site: "", reviewer: "", finance: "", legal: "", ops: "" };
const as = {} as Record<"site" | "legal", TestBrowser>;
let skill = "";
let v1 = "";

const sync = (backoffMs = 60_000) =>
  defaultSyncOnce({ database: h.deps.database, log: logger, backoffMs });

const setDefault = (on: boolean) =>
  as.site.put(`/v1/site/skills/catalog/${skill}/tags`, {
    system: on ? ["default"] : [],
    topic: [],
  });

const installs = async () =>
  (
    await h.admin.query<{ team_id: string; origin: string }>(
      `SELECT team_id, origin FROM team_skill_installs WHERE skill_id = $1 ORDER BY team_id`,
      [skill],
    )
  ).rows;

const job = async (id: string) =>
  (await h.admin.query(`SELECT * FROM skill_default_syncs WHERE id = $1`, [id])).rows[0] as Record<
    string,
    unknown
  >;

async function session(): Promise<pg.Client> {
  const c = new pg.Client({ connectionString: h.adminUrl });
  await c.connect();
  return c;
}

/** Waits until some session waits on an advisory lock (the sync reached the held lock). */
const someoneWaits = () =>
  vi.waitFor(
    async () => {
      const r = await h.admin.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM pg_locks WHERE locktype = 'advisory' AND NOT granted`,
      );
      expect(r.rows[0]?.n).toBeGreaterThan(0);
    },
    { timeout: 5000, interval: 20 },
  );

beforeAll(async () => {
  h = await openHarness();
  ids.site = await h.createUser("site@races.test", "admin");
  ids.reviewer = await h.createUser("reviewer@races.test", "admin");
  for (const t of ["finance", "legal", "ops"] as const) {
    ids[t] = await h.createUser(`${t}@races.test`);
    await h.admin.query(`INSERT INTO teams (id, slug, name) VALUES ($1, $2, $2)`, [team[t], t]);
    await h.admin.query(
      `INSERT INTO team_members (team_id, user_id, role) VALUES ($1, $2, 'team_admin')`,
      [team[t], ids[t]],
    );
  }
  skill = (
    await h.admin.query<{ id: string }>(
      `INSERT INTO registry_skills (name, summary) VALUES ('charts-pro', 'Charts.') RETURNING id`,
    )
  ).rows[0]?.id as string;
  v1 = (
    await h.admin.query<{ id: string }>(
      `INSERT INTO registry_versions (skill_id, semver, seq, runtime_hash, package_hash, manifest,
         provenance, source, scan, verdict, state, submitted_by, reviewed_by, approved_at)
       VALUES ($1, '1.0.0', 1, repeat('a', 64), repeat('a', 64), '{}', '{}', '{}', '{}', 'pass',
         'approved', $2, $3, now()) RETURNING id`,
      [skill, ids.legal, ids.reviewer],
    )
  ).rows[0]?.id as string;
  as.site = await h.signIn("site@races.test");
  as.legal = await h.signIn("legal@races.test");
  expect((await as.legal.put("/v1/me/teams/active", { teamId: team.legal })).status).toBe(200);
  as.legal.team = team.legal;
});

afterAll(async () => {
  await h?.close();
});

describe("queue order and current state (B1)", () => {
  it("orders jobs by commit, not by transaction start", async () => {
    const lock = `SELECT pg_advisory_xact_lock(hashtextextended('kobe.skills.default-set', 0))`;
    const insert = `INSERT INTO skill_default_syncs (skill_id, kind, requested_by)
      VALUES ($1, 'remove', $2) RETURNING id, seq, created_at`;
    const [early, late] = [await session(), await session()];
    try {
      await early.query("BEGIN");
      await early.query("SELECT now()");
      // now() has microsecond precision but created_at comes back as a millisecond Date: keep
      // the two transaction starts apart so the comparison below cannot tie (KOBE-480).
      await early.query("SELECT pg_sleep(0.01)");
      await late.query("BEGIN");
      await late.query(lock);
      const first = (await late.query(insert, [skill, ids.site])).rows[0];
      await late.query("COMMIT");
      await early.query(lock);
      const second = (await early.query(insert, [skill, ids.site])).rows[0];
      await early.query("COMMIT");
      // The transaction that began first committed second: its start time is earlier, its seq later.
      expect(second.created_at.getTime()).toBeLessThan(first.created_at.getTime());
      expect(Number(second.seq)).toBeGreaterThan(Number(first.seq));
    } finally {
      await early.end();
      await late.end();
    }
    expect(await sync()).toBe(2);
  });

  it("a fast on-off toggle installs nothing anywhere", async () => {
    const on = await setDefault(true);
    const off = await setDefault(false);
    expect([on.status, off.status]).toEqual([200, 200]);
    expect(await sync()).toBe(2);
    expect(await installs()).toEqual([]);
    expect((await job(on.json.syncId)).installed).toBe(0);
  });

  it("an add that runs after the tag is gone, or a stale remove, changes nothing", async () => {
    // Out of order: the add runs while the skill is not Default.
    const add = await h.deps.database.db.transaction((tx) =>
      queueDefaultSync(tx, {
        skillId: skill,
        kind: "add",
        target: { id: v1, semver: "1.0.0", major: 1 },
        requestedBy: ids.site,
      }),
    );
    expect(await sync()).toBe(1);
    expect(await installs()).toEqual([]);
    expect((await job(add)).status).toBe("done");
    // Now Default; a remove that was queued earlier but runs now leaves installs and opt-outs.
    expect((await setDefault(true)).status).toBe(200);
    expect(await sync()).toBe(1);
    expect(await installs()).toHaveLength(3);
    const stale = await h.deps.database.db.transaction((tx) =>
      queueDefaultSync(tx, { skillId: skill, kind: "remove", requestedBy: ids.site }),
    );
    expect(await sync()).toBe(1);
    expect((await installs()).map((i) => i.origin)).toEqual([
      "default_tag",
      "default_tag",
      "default_tag",
    ]);
    expect((await job(stale)).converted).toBe(0);
  });
});

describe("blocks and opt-outs racing the sync (S4, S6)", () => {
  it("never installs in a team that blocked the skill; Reinstall is refused there", async () => {
    await h.admin.query(`DELETE FROM team_skill_installs WHERE team_id = $1 AND skill_id = $2`, [
      team.legal,
      skill,
    ]);
    await h.admin.query(
      `INSERT INTO team_skill_blocks (team_id, skill_id, blocked_by) VALUES ($1, $2, $3)`,
      [team.legal, skill, ids.legal],
    );
    const add = await h.deps.database.db.transaction((tx) =>
      queueDefaultSync(tx, {
        skillId: skill,
        kind: "add",
        target: { id: v1, semver: "1.0.0", major: 1 },
        requestedBy: ids.site,
      }),
    );
    expect(await sync()).toBe(1);
    expect((await installs()).map((i) => i.team_id)).not.toContain(team.legal);
    expect((await job(add)).blocked).toBe(1);
    await h.admin.query(
      `INSERT INTO team_skill_optouts (team_id, skill_id, opted_out_by) VALUES ($1, $2, $3)`,
      [team.legal, skill, ids.legal],
    );
    const r = await as.legal.post(`/v1/team/skills/removed-defaults/${skill}/reinstall`);
    expect([r.status, r.json.code]).toEqual([409, "blocked"]);
  });

  it("an opt-out committed while the sync waits for the team wins", async () => {
    await h.admin.query(`DELETE FROM team_skill_installs WHERE team_id = $1 AND skill_id = $2`, [
      team.ops,
      skill,
    ]);
    const uninstall = await session();
    try {
      // A Team admin's uninstall in flight: it holds the install lock and records the opt-out.
      await uninstall.query("BEGIN");
      await uninstall.query(`SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`, [
        `kobe.skills.install:${team.ops}:${skill}`,
      ]);
      await uninstall.query(
        `INSERT INTO team_skill_optouts (team_id, skill_id, opted_out_by) VALUES ($1, $2, $3)`,
        [team.ops, skill, ids.ops],
      );
      const add = await h.deps.database.db.transaction((tx) =>
        queueDefaultSync(tx, {
          skillId: skill,
          kind: "add",
          target: { id: v1, semver: "1.0.0", major: 1 },
          requestedBy: ids.site,
        }),
      );
      const running = sync();
      await someoneWaits();
      await uninstall.query("COMMIT");
      expect(await running).toBe(1);
      expect((await installs()).map((i) => i.team_id)).not.toContain(team.ops);
      expect((await job(add)).opted_out).toBe(1);
    } finally {
      await uninstall.end();
    }
  });

  it("an uninstall after the sync installed records the opt-out, and a re-sync keeps it", async () => {
    const finance = await h.signIn("finance@races.test");
    expect((await finance.put("/v1/me/teams/active", { teamId: team.finance })).status).toBe(200);
    finance.team = team.finance;
    expect((await finance.delete(`/v1/team/skills/installs/${skill}`)).json).toEqual({
      optedOut: true,
    });
    await h.deps.database.db.transaction((tx) =>
      queueDefaultSync(tx, {
        skillId: skill,
        kind: "add",
        target: { id: v1, semver: "1.0.0", major: 1 },
        requestedBy: ids.site,
      }),
    );
    expect(await sync()).toBe(1);
    expect(await installs()).toEqual([]);
  });
});

describe("a failing job (S5)", () => {
  it("is retried with backoff, then parked as failed; later jobs still run", async () => {
    // No approved version in major 9: the job can't install anything.
    const failing = await h.deps.database.db.transaction((tx) =>
      queueDefaultSync(tx, {
        skillId: skill,
        kind: "add",
        target: { id: v1, semver: "9.0.0", major: 9 },
        requestedBy: ids.site,
      }),
    );
    const later = await h.deps.database.db.transaction((tx) =>
      queueDefaultSync(tx, { skillId: skill, kind: "remove", requestedBy: ids.site }),
    );
    expect(await sync()).toBe(2);
    expect(await job(failing)).toMatchObject({
      status: "running",
      attempts: 1,
      last_error: "no_version",
    });
    expect((await job(later)).status).toBe("done");
    for (let i = 0; i < 4; i += 1) {
      await h.admin.query(
        `UPDATE skill_default_syncs SET next_attempt_at = now() - interval '1 second' WHERE id = $1`,
        [failing],
      );
      expect(await sync()).toBe(1);
    }
    expect(await job(failing)).toMatchObject({ status: "failed", attempts: 5 });
    expect(await sync()).toBe(0);
    const audit = await h.admin.query(
      `SELECT target FROM audit_log WHERE action = 'skill.default.sync_failed'`,
    );
    expect(audit.rows).toEqual([
      {
        target: {
          skillId: skill,
          name: "charts-pro",
          kind: "add",
          attempts: 5,
          error: "no_version",
        },
      },
    ]);
    const list = await as.site.get("/v1/site/skills/default-syncs");
    expect(list.json.syncs.find((s: { id: string }) => s.id === failing)).toMatchObject({
      status: "failed",
      lastError: "no_version",
      attempts: 5,
    });
  });
});
