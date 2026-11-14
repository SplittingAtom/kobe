import { randomUUID } from "node:crypto";
import pg from "pg";
import pino from "pino";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { runWithAuditContext } from "./audit/context.js";
import { createOffboarding } from "./offboarding/index.js";
import { purgeDeparted } from "./offboarding/purge.js";
import { runRetentionPass } from "./retention/index.js";
import type { TestBrowser } from "./testing/browser.js";
import { openHarness, type Harness } from "./testing/harness.js";
import {
  deactivateUser as deactivate,
  reactivateUserIfVia as reactivate,
} from "./users/deactivation.js";

/**
 * KOBE-386 (v1.3 SM28, Q7): semantic memory retention sweeps, offboarding and SSO/SCIM
 * deactivation. Workspace items follow the team's window, Site and portable items the Site window
 * (`retention_days`); evidence drops with its source conversation; a departed member's personal
 * items go 30 days after they left; portable items survive deactivation until a site admin purges
 * them. Holds always win: the hold lock first, held owners, Site-wide holds and held authors skipped.
 */
let h: Harness;
const log = pino({ level: "silent" });
const ids = {
  owner: "",
  admin: "",
  alice: "",
  bob: "",
  carol: "",
  dora: "",
  erin: "",
  finn: "",
};
const as = {} as { admin: TestBrowser };
let team = "";
let auditFloor = 0;
const SCIM = "scim:11111111-2222-4333-8444-555555555555";

/** The SCIM path's calls, as the provider's request would make them (an actor in context). */
const asScim = <T>(fn: () => Promise<T>) =>
  runWithAuditContext({ actor: { kind: "user", id: ids.admin }, ip: null, userAgent: null }, fn);
const deactivateUser = (...a: Parameters<typeof deactivate>) => asScim(() => deactivate(...a));
const reactivateUserIfVia = (...a: Parameters<typeof reactivate>) => asScim(() => reactivate(...a));

const DAY = 86_400_000;
const ago = (days: number) => new Date(Date.now() - days * DAY).toISOString();
const pass = () => runRetentionPass({ db: h.deps.database.db, logger: log });
const offboardingCtx = () => ({
  db: h.deps.database.db,
  provider: () => undefined,
  blobs: undefined,
  log,
});

interface ItemSpec {
  readonly owner?: string;
  readonly status?: "active" | "archived" | "superseded";
  readonly supersededBy?: string;
  /** Days since the item's last change. */
  readonly updated?: number;
  /** Age in days of each version, oldest first; the last one is current. */
  readonly versions?: readonly number[];
  readonly actor?: string;
  readonly sourceThread?: string;
  readonly asOf?: string;
}

const statusOf = (spec: ItemSpec) => spec.status ?? (spec.supersededBy ? "superseded" : "active");

/** A Workspace item with its versions, in one statement (the current-version check is deferred). */
async function ws(spec: ItemSpec): Promise<string> {
  const id = randomUUID();
  const ages = spec.versions ?? [1];
  await h.admin.query(
    `WITH i AS (
       INSERT INTO semantic_memory_items
         (team_id, id, scope, owner_user_id, kind, status, superseded_by, current_version, updated_at, as_of)
       VALUES ($1, $2, $3, $4, 'fact', $5, $6, $7, $8, $12::date))
     INSERT INTO semantic_memory_item_versions
       (team_id, item_id, version, statement, actor_user_id, actor_kind, created_at,
        source_thread_id, source_entry_ids, evidence)
     SELECT $1, $2, g.n, 'statement ' || g.n, $9, 'user', g.at, $10,
            CASE WHEN $10::uuid IS NULL THEN NULL ELSE ARRAY['e1'] END,
            CASE WHEN $10::uuid IS NULL THEN NULL ELSE '{"quote":"we ship on Fridays"}'::jsonb END
       FROM unnest($11::timestamptz[]) WITH ORDINALITY AS g(at, n)`,
    [
      team,
      id,
      spec.owner ? "user" : "team",
      spec.owner ?? null,
      statusOf(spec),
      spec.supersededBy ?? null,
      ages.length,
      ago(spec.updated ?? 0),
      spec.actor ?? spec.owner ?? ids.alice,
      spec.sourceThread ?? null,
      ages.map(ago),
      spec.asOf ?? null,
    ],
  );
  return id;
}

async function site(spec: ItemSpec): Promise<string> {
  const id = randomUUID();
  const ages = spec.versions ?? [1];
  await h.admin.query(
    `WITH i AS (
       INSERT INTO site_memory_items (id, kind, status, superseded_by, current_version, updated_at)
       VALUES ($1, 'fact', $2, $3, $4, $5))
     INSERT INTO site_memory_item_versions (item_id, version, statement, actor_user_id, actor_kind, created_at)
     SELECT $1, g.n, 'site ' || g.n, $6, 'user', g.at
       FROM unnest($7::timestamptz[]) WITH ORDINALITY AS g(at, n)`,
    [
      id,
      statusOf(spec),
      spec.supersededBy ?? null,
      ages.length,
      ago(spec.updated ?? 0),
      spec.actor ?? ids.admin,
      ages.map(ago),
    ],
  );
  return id;
}

async function portable(owner: string, spec: Omit<ItemSpec, "owner"> = {}): Promise<string> {
  const id = randomUUID();
  const ages = spec.versions ?? [1];
  await h.admin.query(
    `WITH i AS (
       INSERT INTO portable_memory_items (id, owner_user_id, kind, status, superseded_by, current_version, updated_at)
       VALUES ($1, $2, 'preference', $3, $4, $5, $6))
     INSERT INTO portable_memory_item_versions (item_id, version, statement, actor_user_id, actor_kind, created_at)
     SELECT $1, g.n, 'prefers ' || g.n, $2, 'user', g.at
       FROM unnest($7::timestamptz[]) WITH ORDINALITY AS g(at, n)`,
    [
      id,
      owner,
      statusOf(spec),
      spec.supersededBy ?? null,
      ages.length,
      ago(spec.updated ?? 0),
      ages.map(ago),
    ],
  );
  return id;
}

const TABLES = {
  ws: "semantic_memory_item_versions",
  site: "site_memory_item_versions",
  portable: "portable_memory_item_versions",
} as const;
const versionsOf = async (lane: keyof typeof TABLES, id: string) =>
  (
    await h.admin.query<{ version: number }>(
      `SELECT version FROM ${TABLES[lane]} WHERE item_id = $1 ORDER BY version`,
      [id],
    )
  ).rows.map((r) => r.version);

async function audits(action: string) {
  const { rows } = await h.admin.query<{
    target: Record<string, unknown>;
    actor_id: string | null;
  }>(`SELECT target, actor_id FROM audit_log WHERE action = $1 AND seq > $2 ORDER BY seq`, [
    action,
    auditFloor,
  ]);
  return rows;
}
const sum = (rows: { target: Record<string, unknown> }[], key: string) =>
  rows.reduce((n, r) => n + Number(r.target[key] ?? 0), 0);

async function setPeriod(period: string | null): Promise<void> {
  if (period === null) return void (await h.admin.query(`DELETE FROM team_retention`));
  await h.admin.query(
    `INSERT INTO team_retention (team_id, period, updated_by) VALUES ($1, $2, $3)
     ON CONFLICT (team_id) DO UPDATE SET period = EXCLUDED.period`,
    [team, period, ids.alice],
  );
}

async function placeHold(userId: string | null): Promise<string> {
  const { rows } = await h.admin.query<{ id: string }>(
    `INSERT INTO legal_holds (team_id, user_id, reason, placed_by) VALUES ($1, $2, 'matter 386', $3)
     RETURNING id`,
    [team, userId, ids.admin],
  );
  const id = rows[0]?.id ?? "";
  await h.admin.query(`UPDATE legal_holds SET status = 'active', approved_by = $2 WHERE id = $1`, [
    id,
    ids.owner,
  ]);
  return id;
}

async function placeSiteHold(): Promise<void> {
  const { rows } = await h.admin.query<{ id: string }>(
    `INSERT INTO site_legal_holds (reason, placed_by) VALUES ('Site matter 386', $1) RETURNING id`,
    [ids.admin],
  );
  await h.admin.query(
    `UPDATE site_legal_holds SET status = 'active', approved_by = $2 WHERE id = $1`,
    [rows[0]?.id, ids.owner],
  );
}

async function clearHolds(): Promise<void> {
  for (const table of ["legal_holds", "site_legal_holds"]) {
    const { rows } = await h.admin.query<{ id: string }>(
      `SELECT id FROM ${table} WHERE status = 'active'`,
    );
    for (const { id } of rows) {
      await h.admin.query(
        `UPDATE ${table} SET release_requested_by = $2, release_requested_at = now(),
           release_reason = 'matter closed' WHERE id = $1`,
        [id, ids.admin],
      );
      await h.admin.query(
        `UPDATE ${table} SET status = 'released', released_by = $2 WHERE id = $1`,
        [id, ids.owner],
      );
    }
  }
}

async function member(userId: string, on: boolean): Promise<void> {
  if (on)
    await h.admin.query(
      `INSERT INTO team_members (team_id, user_id, role) VALUES ($1, $2, 'member') ON CONFLICT DO NOTHING`,
      [team, userId],
    );
  else
    await h.admin.query(`DELETE FROM team_members WHERE team_id = $1 AND user_id = $2`, [
      team,
      userId,
    ]);
}

beforeAll(async () => {
  h = await openHarness();
  ids.owner = await h.createUser("owner@smret.test", "owner");
  ids.admin = await h.createUser("admin@smret.test", "admin");
  for (const who of ["alice", "bob", "carol", "dora", "erin", "finn"] as const)
    ids[who] = await h.createUser(`${who}@smret.test`);
  team = randomUUID();
  await h.admin.query(`INSERT INTO teams (id, slug, name) VALUES ($1, 'smret', 'SMRet')`, [team]);
  await h.admin.query(
    `INSERT INTO team_members (team_id, user_id, role) VALUES ($1, $2, 'team_admin')`,
    [team, ids.owner],
  );
  as.admin = await h.signIn("admin@smret.test");
}, 120_000);

afterAll(() => h?.close());

beforeEach(async () => {
  await clearHolds();
  await setPeriod(null);
  for (const who of ["alice", "bob", "carol", "dora", "erin"] as const)
    await member(ids[who], true);
  await h.admin.query(`UPDATE users SET deactivated_at = NULL, deactivated_via = NULL`);
  await h.admin.query(`DELETE FROM semantic_memory_items WHERE team_id = $1`, [team]);
  await h.admin.query(`DELETE FROM portable_memory_items`);
  await h.admin.query(`DELETE FROM site_memory_items`);
  await h.admin.query(`DELETE FROM sandboxes WHERE team_id = $1`, [team]);
  await h.admin.query(
    `INSERT INTO site_settings (key, value) VALUES ('memory.settings', $1)
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
    [JSON.stringify({ retention_days: 30 })],
  );
  auditFloor = Number(
    (await h.admin.query<{ n: string }>(`SELECT coalesce(max(seq), 0) AS n FROM audit_log`)).rows[0]
      ?.n,
  );
});

const exists = async (table: string, id: string) =>
  (await h.admin.query(`SELECT 1 FROM ${table} WHERE id = $1`, [id])).rowCount === 1;

describe("Workspace sweep (ac-1)", () => {
  it("purges archived and superseded items past the window, never a live one", async () => {
    await setPeriod("30d");
    const archived = await ws({
      owner: ids.alice,
      status: "archived",
      updated: 40,
      versions: [90, 50],
    });
    const recent = await ws({ owner: ids.alice, status: "archived", updated: 10 });
    const live = await ws({ updated: 400, versions: [400] });
    // A superseded chain: `older` names `successor`, which is archived too; both go.
    const successor = await ws({ status: "archived", updated: 60 });
    const older = await ws({ supersededBy: successor, updated: 70 });
    // A superseded item whose successor is live: it goes, the successor stays.
    const current = await ws({ updated: 1 });
    const replaced = await ws({ supersededBy: current, updated: 45 });
    await pass();
    for (const gone of [archived, successor, older, replaced])
      expect(await exists("semantic_memory_items", gone)).toBe(false);
    expect(await versionsOf("ws", archived)).toEqual([]);
    for (const kept of [recent, live, current])
      expect(await exists("semantic_memory_items", kept)).toBe(true);
    const rows = await audits("retention.semantic_memory_purged");
    expect(rows.every((r) => r.target.reason === "retention")).toBe(true);
    expect([sum(rows, "items"), sum(rows, "versions")]).toEqual([4, 5]);
  });

  it("purges versions replaced longer ago than the window; the current one and recent history stay", async () => {
    await setPeriod("30d");
    const item = await ws({ owner: ids.alice, versions: [100, 60, 5] });
    const old = await ws({ versions: [500] });
    await pass();
    expect(await versionsOf("ws", item)).toEqual([2, 3]);
    expect(await versionsOf("ws", old)).toEqual([1]);
  });

  it("purges nothing by age while the Workspace keeps conversations forever", async () => {
    const archived = await ws({ status: "archived", updated: 900, versions: [999, 950] });
    await pass();
    expect(await versionsOf("ws", archived)).toEqual([1, 2]);
  });

  it("skips a held owner's items, and with a Workspace-wide hold every item", async () => {
    await setPeriod("30d");
    await placeHold(ids.bob);
    const bobs = await ws({ owner: ids.bob, status: "archived", updated: 90, versions: [100, 60] });
    const bobVersions = await ws({ owner: ids.bob, versions: [100, 60, 5] });
    const alices = await ws({ owner: ids.alice, status: "archived", updated: 90 });
    await pass();
    expect(await versionsOf("ws", bobs)).toEqual([1, 2]);
    expect(await versionsOf("ws", bobVersions)).toEqual([1, 2, 3]);
    expect(await exists("semantic_memory_items", alices)).toBe(false);

    await placeHold(null);
    const shared = await ws({ status: "archived", updated: 90 });
    const carols = await ws({ owner: ids.carol, versions: [100, 60, 5] });
    await pass();
    expect(await exists("semantic_memory_items", shared)).toBe(true);
    expect(await versionsOf("ws", carols)).toEqual([1, 2, 3]);
  });

  it("takes the hold lock first: a hold approved while the sweep waits wins", async () => {
    await setPeriod("30d");
    const item = await ws({ owner: ids.alice, status: "archived", updated: 90 });
    const client = new pg.Client({ connectionString: h.adminUrl });
    await client.connect();
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock(hashtextextended('kobe.legal_hold', 0))");
    const sweep = pass();
    await new Promise((r) => setTimeout(r, 300));
    const { rows } = await client.query<{ id: string }>(
      `INSERT INTO legal_holds (team_id, user_id, reason, placed_by) VALUES ($1, $2, 'mid-sweep', $3)
       RETURNING id`,
      [team, ids.alice, ids.admin],
    );
    await client.query(`UPDATE legal_holds SET status = 'active', approved_by = $2 WHERE id = $1`, [
      rows[0]?.id,
      ids.owner,
    ]);
    await client.query("COMMIT");
    await client.end();
    await sweep;
    expect(await exists("semantic_memory_items", item)).toBe(true);
  });

  it("drops evidence with its source conversation; a held item keeps it until released", async () => {
    const thread = randomUUID();
    await h.admin.query(
      `INSERT INTO threads (team_id, id, owner_user_id, title, deleted_at) VALUES ($1, $2, $3, 'src', $4)`,
      [team, thread, ids.alice, ago(31)],
    );
    const alices = await ws({ owner: ids.alice, sourceThread: thread, versions: [10, 2] });
    const bobs = await ws({ owner: ids.bob, sourceThread: thread });
    await placeHold(ids.bob);
    await pass();
    expect(await exists("threads", thread)).toBe(false);
    const read = async (id: string) =>
      (
        await h.admin.query<{
          statement: string;
          evidence: unknown;
          src: string | null;
          e: string[] | null;
        }>(
          `SELECT statement, evidence, source_thread_id AS src, source_entry_ids AS e
             FROM semantic_memory_item_versions WHERE item_id = $1 ORDER BY version`,
          [id],
        )
      ).rows;
    // The memory stays ("source deleted"); only the quote and links go.
    expect(await read(alices)).toEqual([
      { statement: "statement 1", evidence: null, src: null, e: null },
      { statement: "statement 2", evidence: null, src: null, e: null },
    ]);
    expect((await read(bobs))[0]?.src).toBe(thread);
    await clearHolds();
    await pass();
    expect((await read(bobs))[0]).toEqual({
      statement: "statement 1",
      evidence: null,
      src: null,
      e: null,
    });
    expect(sum(await audits("retention.semantic_memory_purged"), "scrubbed")).toBe(1);
  });
});

describe("Site and portable sweep (ac-1, ac-5)", () => {
  it("purges archived Site items and old versions past the Site window", async () => {
    const archived = await site({ status: "archived", updated: 40, versions: [60, 45] });
    const recent = await site({ status: "archived", updated: 20 });
    const live = await site({ versions: [100, 50, 5] });
    await pass();
    expect(await exists("site_memory_items", archived)).toBe(false);
    expect(await exists("site_memory_items", recent)).toBe(true);
    expect(await versionsOf("site", live)).toEqual([2, 3]);
    const rows = await audits("retention.site_memory_purged");
    expect(rows.map((r) => r.target)).toContainEqual({
      lane: "site",
      reason: "retention",
      items: 1,
      versions: 2,
      kept: 0,
    });
  });

  it("deletes no Site memory while a Site-wide hold is in force", async () => {
    const archived = await site({ status: "archived", updated: 90 });
    const live = await site({ versions: [100, 50, 5] });
    await placeSiteHold();
    await pass();
    expect(await exists("site_memory_items", archived)).toBe(true);
    expect(await versionsOf("site", live)).toEqual([1, 2, 3]);
    await clearHolds();
    await pass();
    expect(await exists("site_memory_items", archived)).toBe(false);
  });

  it("keeps the Site items a held person wrote", async () => {
    await placeHold(ids.carol);
    const carols = await site({ status: "archived", updated: 90, actor: ids.carol });
    const others = await site({ status: "archived", updated: 90 });
    await pass();
    expect(await exists("site_memory_items", carols)).toBe(true);
    expect(await exists("site_memory_items", others)).toBe(false);
  });

  it("purges archived portable items and old versions; a held owner keeps theirs", async () => {
    const archived = await portable(ids.dora, { status: "archived", updated: 40 });
    const live = await portable(ids.dora, { versions: [100, 50, 5] });
    const held = await portable(ids.bob, { status: "archived", updated: 90 });
    await placeHold(ids.bob);
    await pass();
    expect(await exists("portable_memory_items", archived)).toBe(false);
    expect(await versionsOf("portable", live)).toEqual([2, 3]);
    expect(await exists("portable_memory_items", held)).toBe(true);
  });
});

describe("Workspace-wide holds and portable items (Q2)", () => {
  it("freeze only the portable items of members of the held Workspace", async () => {
    // finn is in no Workspace; dora is a member of the held one.
    const doras = await portable(ids.dora, { status: "archived", updated: 90 });
    const finns = await portable(ids.finn, { status: "archived", updated: 90 });
    const finnVersions = await portable(ids.finn, { versions: [100, 50, 5] });
    await placeHold(null);
    await pass();
    expect(await exists("portable_memory_items", doras)).toBe(true);
    expect(await exists("portable_memory_items", finns)).toBe(false);
    expect(await versionsOf("portable", finnVersions)).toEqual([2, 3]);
  });

  it("refuse an admin purge only for members of the held Workspace", async () => {
    await portable(ids.dora);
    await portable(ids.finn);
    await deactivateUser(h.deps.database.db, ids.dora, { via: SCIM });
    await deactivateUser(h.deps.database.db, ids.finn, { via: SCIM });
    await placeHold(null);
    const dora = await as.admin.post(`/v1/site/users/${ids.dora}/portable-memory/purge`);
    expect([dora.status, dora.json.code]).toEqual([409, "legal_hold"]);
    const finn = await as.admin.post(`/v1/site/users/${ids.finn}/portable-memory/purge`);
    expect(finn.status, JSON.stringify(finn.json)).toBe(200);
    expect(finn.json).toMatchObject({ purged: 1, kept: 0 });
  });
});

describe("stale (KOBE-386, threshold from KOBE-381)", () => {
  it("flags active items neither changed nor dated within the threshold, and filters on it", async () => {
    const old = await ws({ owner: ids.alice, updated: 100, versions: [100] });
    const fresh = await ws({ owner: ids.alice, updated: 10, versions: [10] });
    const dated = await ws({
      owner: ids.alice,
      updated: 100,
      versions: [100],
      asOf: ago(5).slice(0, 10),
    });
    const alice = await h.signIn("alice@smret.test");
    await alice.put("/v1/me/teams/active", { teamId: team });
    alice.team = team;
    const ITEMS = "/v1/memory/semantic/items";
    const list = await alice.get(`${ITEMS}?scope=user`);
    expect(list.status, JSON.stringify(list.json)).toBe(200);
    const flags = Object.fromEntries(
      (list.json.items as { id: string; stale: boolean }[]).map((i) => [i.id, i.stale]),
    );
    expect(flags).toEqual({ [old]: true, [fresh]: false, [dated]: false });
    const only = await alice.get(`${ITEMS}?scope=user&stale=true`);
    expect((only.json.items as { id: string }[]).map((i) => i.id)).toEqual([old]);
    const not = await alice.get(`${ITEMS}?scope=user&stale=false`);
    expect((not.json.items as { id: string }[]).map((i) => i.id).sort()).toEqual(
      [fresh, dated].sort(),
    );
    expect((await alice.get(`${ITEMS}/user/${old}`)).json.stale).toBe(true);
    // The threshold is the Site setting.
    await h.admin.query(`UPDATE site_settings SET value = $1 WHERE key = 'memory.settings'`, [
      JSON.stringify({ retention_days: 30, stale_after_days: 7 }),
    ]);
    expect((await alice.get(`${ITEMS}/user/${fresh}`)).json.stale).toBe(true);
  });
});

describe("offboarding (ac-2)", () => {
  async function departed(userId: string, retainDays = -1): Promise<void> {
    await member(userId, false);
    await h.admin.query(
      `INSERT INTO sandboxes (team_id, user_id, sandbox_id, state, pvc, retain_until)
       VALUES ($1, $2, $3, 'destroyed', NULL, now() + make_interval(days => $4))`,
      [team, userId, randomUUID(), retainDays],
    );
  }

  it("purges a departed member's personal items after 30 days; Workspace and portable items stay", async () => {
    const mine = await ws({ owner: ids.bob, versions: [5, 4] });
    const archived = await ws({ owner: ids.bob, status: "archived" });
    const chain = await ws({ owner: ids.bob, supersededBy: mine });
    const shared = await ws({ actor: ids.bob });
    const alices = await ws({ owner: ids.alice });
    const pref = await portable(ids.bob);
    await departed(ids.bob);
    await expect(purgeDeparted(offboardingCtx(), { teamId: team, userId: ids.bob })).resolves.toBe(
      "deleted",
    );
    for (const gone of [mine, archived, chain])
      expect(await exists("semantic_memory_items", gone)).toBe(false);
    // "Former member": the Workspace item they wrote stays, as do others' and their portable ones.
    expect(await versionsOf("ws", shared)).toEqual([1]);
    expect(await exists("semantic_memory_items", alices)).toBe(true);
    expect(await exists("portable_memory_items", pref)).toBe(true);
    expect((await audits("retention.semantic_memory_purged")).map((r) => r.target)).toEqual([
      { reason: "offboarding", userId: ids.bob, items: 3, versions: 4, scrubbed: 0 },
    ]);
  });

  it("keeps them inside the 30 days, under a hold, and when the member came back", async () => {
    const mine = await ws({ owner: ids.bob });
    await departed(ids.bob, 10);
    await expect(purgeDeparted(offboardingCtx(), { teamId: team, userId: ids.bob })).resolves.toBe(
      "not_due",
    );
    await h.admin.query(
      `UPDATE sandboxes SET retain_until = now() - interval '1 minute' WHERE user_id = $1`,
      [ids.bob],
    );
    await placeHold(ids.bob);
    await expect(purgeDeparted(offboardingCtx(), { teamId: team, userId: ids.bob })).resolves.toBe(
      "held",
    );
    await clearHolds();
    await member(ids.bob, true);
    await purgeDeparted(offboardingCtx(), { teamId: team, userId: ids.bob });
    expect(await exists("semantic_memory_items", mine)).toBe(true);
  });

  it("starts the 30 days for a departed owner who never had a sandbox", async () => {
    const mine = await ws({ owner: ids.erin });
    await member(ids.erin, false);
    const offboarding = createOffboarding({ db: h.deps.database.db, blobs: undefined, log });
    await offboarding.sweep();
    const row = await h.admin.query<{ state: string; days: number }>(
      `SELECT state, round(extract(epoch FROM retain_until - now()) / 86400)::int AS days
         FROM sandboxes WHERE team_id = $1 AND user_id = $2`,
      [team, ids.erin],
    );
    expect(row.rows).toEqual([{ state: "destroyed", days: 30 }]);
    expect(await exists("semantic_memory_items", mine)).toBe(true);
    await h.admin.query(
      `UPDATE sandboxes SET retain_until = now() - interval '1 minute' WHERE user_id = $1`,
      [ids.erin],
    );
    await offboarding.sweep();
    expect(await exists("semantic_memory_items", mine)).toBe(false);
  });
});

describe("deactivation (ac-3)", () => {
  const snapshot = async (owner: string) =>
    (
      await h.admin.query(
        `SELECT i.id, i.status, i.pinned, i.tags, i.current_version, i.updated_at,
                v.version, v.statement, v.created_at
           FROM portable_memory_items i JOIN portable_memory_item_versions v ON v.item_id = i.id
          WHERE i.owner_user_id = $1 ORDER BY i.id, v.version`,
        [owner],
      )
    ).rows;

  it("keeps portable items through SCIM deactivation and restores them unchanged on reactivation by the same source", async () => {
    await portable(ids.dora, { versions: [10, 2] });
    await portable(ids.dora, { status: "archived", updated: 5 });
    const before = await snapshot(ids.dora);
    expect(before).toHaveLength(3);
    await deactivateUser(h.deps.database.db, ids.dora, { via: SCIM });
    await asScim(() => h.deps.lifecycle.emit("deactivated", ids.dora));
    await createOffboarding({ db: h.deps.database.db, blobs: undefined, log }).sweep();
    await pass();
    expect(await snapshot(ids.dora)).toEqual(before);
    // Only the source that deactivated reactivates (SSO11).
    await expect(reactivateUserIfVia(h.deps.database.db, ids.dora, "admin")).resolves.toBe(
      "refused",
    );
    await expect(reactivateUserIfVia(h.deps.database.db, ids.dora, SCIM)).resolves.toBe(
      "reactivated",
    );
    expect(await snapshot(ids.dora)).toEqual(before);
    const dora = await h.signIn("dora@smret.test");
    const list = await dora.get("/v1/memory/semantic/items?scope=portable");
    expect(list.status, JSON.stringify(list.json)).toBe(200);
    expect(list.json.items).toHaveLength(1);
  });

  it("a JIT duplicate account starts with no portable memories", async () => {
    await portable(ids.dora);
    await h.createUser("dora.sso@smret.test");
    const twin = await h.signIn("dora.sso@smret.test");
    const list = await twin.get("/v1/memory/semantic/items?scope=portable");
    expect(list.status, JSON.stringify(list.json)).toBe(200);
    expect(list.json.items).toEqual([]);
    expect(await snapshot(ids.dora)).toHaveLength(1);
  });

  it("purges portable items only on a site admin's purge of a deactivated account, never under a hold", async () => {
    const a = await portable(ids.dora, { versions: [3, 2] });
    const b = await portable(ids.dora, { supersededBy: a });
    const path = `/v1/site/users/${ids.dora}/portable-memory/purge`;
    const active = await as.admin.post(path);
    expect([active.status, active.json.code]).toEqual([409, "user_active"]);
    await deactivateUser(h.deps.database.db, ids.dora, { via: SCIM });
    await placeHold(ids.dora);
    const held = await as.admin.post(path);
    expect([held.status, held.json.code]).toEqual([409, "legal_hold"]);
    expect(await snapshot(ids.dora)).toHaveLength(3);
    await clearHolds();
    const done = await as.admin.post(path);
    expect(done.status, JSON.stringify(done.json)).toBe(200);
    expect(done.json).toMatchObject({ purged: 2, kept: 0 });
    expect(await exists("portable_memory_items", a)).toBe(false);
    expect(await exists("portable_memory_items", b)).toBe(false);
    const rows = await audits("retention.site_memory_purged");
    expect(rows.map((r) => [r.actor_id, r.target])).toEqual([
      [
        ids.admin,
        {
          lane: "portable",
          reason: "offboarding",
          items: 2,
          versions: 3,
          kept: 0,
          userId: ids.dora,
        },
      ],
    ]);
  });
});
