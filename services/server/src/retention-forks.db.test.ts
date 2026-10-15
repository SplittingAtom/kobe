import { randomUUID } from "node:crypto";
import pg from "pg";
import pino from "pino";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { runWithAuditContext } from "./audit/context.js";
import { purgeThreads, runRetentionPass } from "./retention/index.js";
import { createTeamWithAdmin } from "./teams/members.js";
import type { TestBrowser } from "./testing/browser.js";
import { openHarness, type Harness } from "./testing/harness.js";

/**
 * KOBE-216 ac-4 (review-280 M1): purging a fork's source clears the fork's link (ON DELETE SET
 * NULL), which locks the fork's row. A purge locks a source's forks with SKIP LOCKED first and
 * leaves out a source whose forks are busy (a run on the fork holds its row), so it never waits
 * on a live conversation: the source is purged on a later pass, and no step fails or answers 500.
 */
let h: Harness;
let team = "";
const ids = { alice: "", bob: "" };
let bob: TestBrowser;
const log = pino({ level: "silent" });
const DAY = 86_400_000;
const ago = (days: number) => new Date(Date.now() - days * DAY);
const noAudit = async () => {};

/** A thread with one entry (superuser fixture); a fork's link is set at INSERT (KOBE-215). */
async function thread(spec: { deletedAt?: Date; forkOf?: string } = {}): Promise<string> {
  const id = randomUUID();
  await h.admin.query(
    `INSERT INTO threads (team_id, id, owner_user_id, title, deleted_at,
                          forked_from_thread_id, forked_at_entry_id)
     VALUES ($1, $2, $3, 't', $4, $5, $6)`,
    [team, id, ids.bob, spec.deletedAt ?? null, spec.forkOf ?? null, spec.forkOf ? "e1" : null],
  );
  await h.admin.query(
    `INSERT INTO thread_entries (team_id, thread_id, entry_id, parent_id, type, payload)
     VALUES ($1, $2, 'e1', NULL, 'message', '{"type":"message","id":"e1"}')`,
    [team, id],
  );
  return id;
}

async function threadIds(): Promise<string[]> {
  const { rows } = await h.admin.query<{ id: string }>(
    `SELECT id FROM threads WHERE team_id = $1 ORDER BY id`,
    [team],
  );
  return rows.map((r) => r.id);
}

async function link(id: string): Promise<string | null> {
  const { rows } = await h.admin.query<{ f: string | null }>(
    `SELECT forked_from_thread_id AS f FROM threads WHERE team_id = $1 AND id = $2`,
    [team, id],
  );
  return rows[0]?.f ?? null;
}

/** A second session holding `id`'s row as a run on it does (`lockThreadRow`, KOBE-266). */
async function holdRow(id: string): Promise<{ release: () => Promise<void> }> {
  const client = new pg.Client({ connectionString: h.adminUrl });
  await client.connect();
  await client.query("BEGIN");
  await client.query(`SELECT 1 FROM threads WHERE team_id = $1 AND id = $2 FOR NO KEY UPDATE`, [
    team,
    id,
  ]);
  return {
    release: async () => {
      await client.query("COMMIT");
      await client.end();
    },
  };
}

const trashPurge = () =>
  purgeThreads(h.deps.database.db, team, { kind: "trash" }, noAudit, { maxBatches: 5 });

beforeAll(async () => {
  h = await openHarness();
  ids.alice = await h.createUser("alice@forks.test");
  ids.bob = await h.createUser("bob@forks.test");
  team = (
    await runWithAuditContext(
      { actor: { kind: "user", id: ids.alice }, ip: null, userAgent: null },
      () => createTeamWithAdmin(h.deps.database.db, { slug: "forks", name: "forks" }, ids.alice),
    )
  ).id;
  await h.admin.query(
    `INSERT INTO team_members (team_id, user_id, role) VALUES ($1, $2, 'member')`,
    [team, ids.bob],
  );
  bob = await h.signIn("bob@forks.test");
  expect((await bob.put("/v1/me/teams/active", { teamId: team })).status).toBe(200);
  bob.team = team;
}, 120_000);

afterAll(() => h?.close());

beforeEach(async () => {
  await h.admin.query(`DELETE FROM threads WHERE team_id = $1`, [team]);
});

describe("purging a source whose fork is busy (KOBE-216 ac-4)", () => {
  it("skips the source without waiting while a fork is locked, and purges it on the next pass", async () => {
    const source = await thread({ deletedAt: ago(31) });
    const other = await thread({ deletedAt: ago(32) });
    const fork = await thread({ forkOf: source });
    const held = await holdRow(fork);
    try {
      const started = Date.now();
      const outcome = await trashPurge();
      // Never waits for the lock (lock_timeout is 5 s): skipped, not failed.
      expect(Date.now() - started).toBeLessThan(3_000);
      expect(outcome).toMatchObject({ status: "done", counts: { threads: 1 } });
      expect(await threadIds()).toEqual([source, fork].sort());
      expect(await link(fork)).toBe(source);
      expect(other).not.toBe(source);
    } finally {
      await held.release();
    }
    expect(await trashPurge()).toMatchObject({ status: "done", counts: { threads: 1 } });
    expect(await threadIds()).toEqual([fork]);
    expect(await link(fork)).toBeNull();
  });

  it("does not let skipped sources starve the rest of the selection", async () => {
    const busy = [await thread({ deletedAt: ago(40) }), await thread({ deletedAt: ago(39) })];
    const forks = await Promise.all(busy.map((s) => thread({ forkOf: s })));
    const idle = await thread({ deletedAt: ago(31) });
    const holds = await Promise.all(forks.map(holdRow));
    try {
      // One thread per batch: the two busy sources come first in Trash order.
      const outcome = await purgeThreads(h.deps.database.db, team, { kind: "trash" }, noAudit, {
        limits: { threads: 1, entries: 1_000 },
        maxBatches: 10,
      });
      expect(outcome).toMatchObject({ status: "done", counts: { threads: 1 } });
      expect(await threadIds()).not.toContain(idle);
    } finally {
      await Promise.all(holds.map((x) => x.release()));
    }
  });

  it("purges a fork chain picked in one batch (its own forks are already its locks)", async () => {
    const h0 = await thread({ deletedAt: ago(33) });
    const t1 = await thread({ deletedAt: ago(32), forkOf: h0 });
    const g2 = await thread({ deletedAt: ago(31), forkOf: t1 });
    expect(await trashPurge()).toMatchObject({ status: "done", counts: { threads: 3 } });
    expect(await threadIds()).toEqual([]);
    expect([h0, t1, g2]).toHaveLength(3);
  });

  it("the nightly pass does not fail its step while a fork is busy", async () => {
    const source = await thread({ deletedAt: ago(31) });
    const fork = await thread({ forkOf: source });
    const held = await holdRow(fork);
    try {
      const result = await runRetentionPass({ db: h.deps.database.db, logger: log });
      expect(result.teams.find((t) => t.teamId === team)).toMatchObject({
        trash: { threads: 0 },
        failed: false,
      });
    } finally {
      await held.release();
    }
    expect(await threadIds()).toEqual([source, fork].sort());
    await runRetentionPass({ db: h.deps.database.db, logger: log });
    expect(await threadIds()).toEqual([fork]);
  });

  it("Delete forever answers 204 while a fork is busy; the source leaves Trash and goes later", async () => {
    const source = await thread({ deletedAt: new Date() });
    const fork = await thread({ forkOf: source });
    const held = await holdRow(fork);
    try {
      const started = Date.now();
      const res = await bob.post(`/v1/threads/${source}/purge`);
      expect(res.status, JSON.stringify(res.json)).toBe(204);
      expect(Date.now() - started).toBeLessThan(3_000);
      expect(await threadIds()).toEqual([source, fork].sort());
      expect((await bob.get("/v1/threads/trash")).json.threads).toEqual([]);
    } finally {
      await held.release();
    }
    await trashPurge();
    expect(await threadIds()).toEqual([fork]);
  });
});
