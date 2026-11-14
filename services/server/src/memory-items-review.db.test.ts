import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { semanticMemoryErrorSchema, semanticMemoryItemDetailSchema } from "@kobe/protocol";
import type { TestBrowser } from "./testing/browser.js";
import { openHarness, type Harness } from "./testing/harness.js";

/**
 * KOBE-378 review fixes (docs/ledger/KOBE-378.md): pruning takes the legal-hold lock (M-1), source
 * threads must be readable by the caller (L-2), refusals use contract codes (L-3), a Policy
 * demotion respects the Site-memories switch (L-4), caps hold under concurrency (L-5), supersede
 * checks the replaced item's version (L-6).
 */
let h: Harness;
const teamA = randomUUID();
const ids = { site: "", site2: "", admin: "", member: "", other: "" };
const as = {} as Record<keyof typeof ids, TestBrowser>;
const ITEMS = "/v1/memory/semantic/items";
const unique = (label: string) => `${label} ${randomUUID()} ${randomUUID()}`;
const detail = (json: unknown) => semanticMemoryItemDetailSchema.parse(json);
const errorOf = (r: { status: number; json: unknown }) => [
  r.status,
  semanticMemoryErrorSchema.parse(r.json).code,
];
const save = (
  who: TestBrowser,
  scope: "user" | "portable" | "team" | "site",
  statement: string,
  extra: Record<string, unknown> = {},
) =>
  who.post(ITEMS, {
    scope,
    kind: scope === "portable" ? "preference" : "fact",
    statement,
    ...(scope === "portable" ? { confirm_portable: true } : {}),
    ...extra,
  });

async function settings(value: Record<string, unknown>): Promise<void> {
  await h.admin.query(
    `INSERT INTO site_settings (key, value) VALUES ('memory.settings', $1)
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
    [JSON.stringify(value)],
  );
}

beforeAll(async () => {
  h = await openHarness();
  ids.site = await h.createUser("site@review.test", "admin");
  ids.site2 = await h.createUser("site2@review.test", "admin");
  for (const who of ["admin", "member", "other"] as const)
    ids[who] = await h.createUser(`${who}@review.test`);
  await h.admin.query(`INSERT INTO teams (id, slug, name) VALUES ($1, 'review-a', 'A')`, [teamA]);
  await h.admin.query(
    `INSERT INTO team_members (team_id, user_id, role) VALUES
       ($1, $2, 'member'), ($1, $3, 'team_admin'), ($1, $4, 'member'), ($1, $5, 'member')`,
    [teamA, ids.site, ids.admin, ids.member, ids.other],
  );
  for (const who of Object.keys(ids) as (keyof typeof ids)[]) {
    as[who] = await h.signIn(`${who}@review.test`);
    if (who === "site2") continue;
    await as[who].put("/v1/me/teams/active", { teamId: teamA });
    as[who].team = teamA;
  }
});

afterAll(async () => {
  await h?.close();
});

describe("KOBE-378 review fixes", () => {
  it("M-1: portable pruning waits for the legal-hold lock and sees a hold approved meanwhile", async () => {
    await settings({ version_cap: 5 });
    const id = detail((await save(as.member, "portable", unique("pref"))).json).id;
    for (let n = 0; n < 4; n += 1)
      expect(
        (
          await as.member.patch(`${ITEMS}/portable/${id}`, {
            expected_version: 1 + n,
            statement: unique(`edit ${n}`),
          })
        ).status,
      ).toBe(200);
    // Five versions: the next edit would prune one, unless a hold covers the owner.
    const holder = new pg.Client({ connectionString: h.adminUrl });
    await holder.connect();
    try {
      await holder.query("BEGIN");
      await holder.query(`SELECT pg_advisory_xact_lock(hashtextextended('kobe.legal_hold', 0))`);
      const edit = as.member.patch(`${ITEMS}/portable/${id}`, {
        expected_version: 5,
        statement: unique("edit while a hold is being placed"),
      });
      let done = false;
      void edit.then(() => {
        done = true;
      });
      await new Promise((r) => setTimeout(r, 750));
      expect(done).toBe(false);
      const hold = (
        await holder.query<{ id: string }>(
          `INSERT INTO legal_holds (team_id, user_id, reason, placed_by) VALUES ($1, $2, 'matter', $3) RETURNING id`,
          [teamA, ids.member, ids.site],
        )
      ).rows[0]?.id;
      await holder.query(
        `UPDATE legal_holds SET status = 'active', approved_by = $2 WHERE id = $1`,
        [hold, ids.site2],
      );
      await holder.query("COMMIT");
      expect((await edit).status).toBe(200);
    } finally {
      await holder.end();
    }
    const { rows } = await h.admin.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM portable_memory_item_versions WHERE item_id = $1`,
      [id],
    );
    expect(rows[0]?.n).toBe(6);
    await h.admin.query(
      `UPDATE legal_holds SET release_requested_by = $2, release_requested_at = now(), release_reason = 'done' WHERE user_id = $1`,
      [ids.member, ids.site],
    );
    await h.admin.query(
      `UPDATE legal_holds SET status = 'released', released_by = $2 WHERE user_id = $1`,
      [ids.member, ids.site2],
    );
  });

  it("L-2: a source thread must be one the caller can read", async () => {
    const thread = async (owner: string, shared: boolean) =>
      (
        await h.admin.query<{ id: string }>(
          `INSERT INTO threads (team_id, owner_user_id, title, shared_to_team) VALUES ($1, $2, 'T', $3) RETURNING id`,
          [teamA, owner, shared],
        )
      ).rows[0]?.id;
    const theirs = await thread(ids.other, false);
    const sharedTheirs = await thread(ids.other, true);
    const mine = await thread(ids.member, false);
    expect(
      (await save(as.member, "user", unique("from their thread"), { source_thread_id: theirs }))
        .status,
    ).toBe(400);
    expect(
      (
        await save(as.member, "user", unique("from a shared thread"), {
          source_thread_id: sharedTheirs,
        })
      ).status,
    ).toBe(201);
    expect(
      (await save(as.member, "user", unique("from my thread"), { source_thread_id: mine })).status,
    ).toBe(201);
  });

  it("L-4 (superseded by the coordinator's 2026-11-13 decision, KOBE-385): a Site curator demotes Policy whatever their Workspace's Site memories switch", async () => {
    const pol = detail(
      (await save(as.site, "site", unique("policy to demote"), { policy: true })).json,
    );
    await h.admin.query(
      `UPDATE teams SET settings = jsonb_set(settings, '{memory}', '{"site_memories_enabled": false}') WHERE id = $1`,
      [teamA],
    );
    try {
      // Switches govern what reaches runs, not curation.
      const demoted = await as.site.patch(`${ITEMS}/site/${pol.id}`, {
        expected_version: 1,
        policy: false,
      });
      expect(demoted.status, JSON.stringify(demoted.json)).toBe(200);
      // Editing it as Policy still works (Policy follows the Site master only).
      expect(
        (await as.site.patch(`${ITEMS}/site/${pol.id}`, { expected_version: 1, tags: ["rule"] }))
          .status,
      ).toBe(200);
    } finally {
      await h.admin.query(`UPDATE teams SET settings = settings - 'memory' WHERE id = $1`, [teamA]);
    }
    await h.admin.query(`UPDATE site_memory_items SET status = 'archived' WHERE id = $1`, [pol.id]);
  });

  it("L-6: supersede checks the replaced item's version", async () => {
    const old = detail((await save(as.admin, "team", unique("old rule"))).json);
    await as.admin.patch(`${ITEMS}/team/${old.id}`, { expected_version: 1, tags: ["moved"] });
    await as.admin.patch(`${ITEMS}/team/${old.id}`, {
      expected_version: 1,
      statement: unique("old rule edited"),
    });
    const stale = await save(as.admin, "team", unique("new rule"), {
      supersedes_id: old.id,
      supersedes_expected_version: 1,
    });
    expect(errorOf(stale)).toEqual([409, "memory_version_conflict"]);
    expect(stale.json.current_version).toBe(2);
    expect(
      (
        await save(as.admin, "team", unique("new rule"), {
          supersedes_id: old.id,
          supersedes_expected_version: 2,
        })
      ).status,
    ).toBe(201);
  });
});

describe("caps under concurrency (L-5)", () => {
  it("lets exactly the room's worth of parallel saves through and notifies once", async () => {
    await settings({ scope_limits: { user: 50, portable: 50, team: 5, site: 50 } });
    await h.admin.query(
      `UPDATE semantic_memory_items SET status = 'archived', pinned = false WHERE team_id = $1 AND scope = 'team' AND status = 'active'`,
      [teamA],
    );
    for (let n = 0; n < 3; n += 1) await save(as.admin, "team", unique("seed"));
    const results = await Promise.all(
      Array.from({ length: 6 }, () => save(as.admin, "team", unique("race"))),
    );
    const statuses = results.map((r) => r.status).sort();
    expect(statuses).toEqual([201, 201, 409, 409, 409, 409]);
    const notices = await h.admin.query(
      `SELECT user_id FROM notifications WHERE kind = 'memory.scope.near_full' AND memory_scope = 'team' AND team_id = $1`,
      [teamA],
    );
    expect(notices.rows).toEqual([{ user_id: ids.admin }]);
  });

  it("pins at most 10 when pins race", async () => {
    await settings({ scope_limits: { user: 50, portable: 50, team: 50, site: 50 } });
    const made: string[] = [];
    for (let n = 0; n < 13; n += 1)
      made.push(detail((await save(as.member, "user", unique("pin"), { pinned: n < 9 })).json).id);
    const results = await Promise.all(
      made.slice(9).map((id) => as.member.post(`${ITEMS}/user/${id}/pin`, { pinned: true })),
    );
    expect(results.map((r) => r.status).sort()).toEqual([200, 409, 409, 409]);
  });

  it("keeps Policy within its byte budget when saves race", async () => {
    await h.admin.query(`UPDATE site_memory_items SET status = 'archived' WHERE policy`);
    const long = (n: number) => `${String.fromCharCode(70 + n)} `.repeat(250).trim();
    for (let n = 0; n < 3; n += 1)
      expect(
        (await save(as.site, "site", long(n), { policy: true, overrides: { lint: true } })).status,
      ).toBe(201);
    // 3 × 499 bytes; room for one more of 499, not two.
    const results = await Promise.all(
      [5, 6, 7].map((n) =>
        save(as.site, "site", long(n), { policy: true, overrides: { lint: true } }),
      ),
    );
    expect(results.map((r) => r.status).sort()).toEqual([201, 409, 409]);
    await h.admin.query(`UPDATE site_memory_items SET status = 'archived' WHERE policy`);
  });
});
