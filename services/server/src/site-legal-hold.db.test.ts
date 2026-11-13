import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { sql } from "@kobe/db";
import { semanticMemoryItemDetailSchema } from "@kobe/protocol";
import {
  SiteHoldIsolationError,
  siteMemoryHeld,
  withSiteMemoryPurge,
} from "./legal-hold/site-memory-hold.js";
import { logger } from "./logger.js";
import { tagsFingerprint } from "./memory/items/tag-fingerprint.js";
import type { TestBrowser } from "./testing/browser.js";
import { openHarness, type Harness } from "./testing/harness.js";

/**
 * KOBE-647 (v1.3 SM28) phase 2: the Site-wide legal hold in the Site console (request, two-person
 * placement and release, audited in the Site log) and what it freezes: Site items and versions
 * survive the version cap's pruning (an edit past the cap succeeds and prunes nothing, review M1),
 * Site purges and sweeps (skipped before any delete, READ COMMITTED only, review L2), and changes
 * to an item's row fields under the hold keep their earlier values in the audit log (review L3).
 */
let h: Harness;
const team = randomUUID();
const ids = { owner: "", admin: "", member: "" };
const as = {} as Record<keyof typeof ids, TestBrowser>;

const BASE = "/v1/site/site-legal-hold";
const ITEMS = "/v1/memory/semantic/items";
const REASON = "Litigation hold for matter 2026-647";
const detail = (json: unknown) => semanticMemoryItemDetailSchema.parse(json);
const unique = (label: string) => `${label} ${randomUUID()} ${randomUUID()}`;

async function auditFor(holdId: string) {
  const { rows } = await h.admin.query<{
    action: string;
    team_id: string | null;
    actor_id: string | null;
    target: Record<string, unknown>;
  }>(
    `SELECT action, team_id, actor_id, target FROM audit_log
      WHERE target->>'holdId' = $1 ORDER BY seq`,
    [holdId],
  );
  return rows;
}

async function requestHold(by: keyof typeof ids = "admin"): Promise<string> {
  const res = await as[by].post(BASE, { reason: REASON });
  expect(res.status, JSON.stringify(res.json)).toBe(201);
  return res.json.hold.id as string;
}

async function place(): Promise<string> {
  const id = await requestHold();
  const res = await as.owner.post(`${BASE}/${id}/approve`);
  expect(res.status, JSON.stringify(res.json)).toBe(200);
  return id;
}

async function release(id: string): Promise<void> {
  expect((await as.admin.post(`${BASE}/${id}/release`, { reason: "Matter settled" })).status).toBe(
    200,
  );
  expect((await as.owner.post(`${BASE}/${id}/release/approve`)).status).toBe(200);
}

async function siteItem(): Promise<string> {
  const res = await as.owner.post(ITEMS, { scope: "site", kind: "fact", statement: unique("s") });
  expect(res.status, JSON.stringify(res.json)).toBe(201);
  return detail(res.json).id;
}

async function editStatement(id: string, from: number, times: number): Promise<void> {
  for (let n = 0; n < times; n += 1) {
    const res = await as.owner.patch(`${ITEMS}/site/${id}`, {
      expected_version: from + n,
      statement: unique(`edit ${n}`),
    });
    expect(res.status, JSON.stringify(res.json)).toBe(200);
  }
}

const versionsOf = async (id: string) =>
  (
    await h.admin.query<{ version: number }>(
      `SELECT version FROM site_memory_item_versions WHERE item_id = $1 ORDER BY version`,
      [id],
    )
  ).rows.map((r) => r.version);

beforeAll(async () => {
  h = await openHarness();
  ids.owner = await h.createUser("owner@slh.test", "owner");
  ids.admin = await h.createUser("admin@slh.test", "admin");
  ids.member = await h.createUser("member@slh.test");
  await h.admin.query(`INSERT INTO teams (id, slug, name) VALUES ($1, 'slh', 'SLH')`, [team]);
  await h.admin.query(
    `INSERT INTO team_members (team_id, user_id, role) VALUES ($1, $2, 'team_admin'), ($1, $3, 'member'), ($1, $4, 'member')`,
    [team, ids.owner, ids.admin, ids.member],
  );
  await h.admin.query(
    `INSERT INTO site_settings (key, value) VALUES ('memory.settings', $1)
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
    [
      JSON.stringify({
        scope_limits: { user: 50, portable: 50, team: 50, site: 50 },
        version_cap: 5,
      }),
    ],
  );
  for (const who of Object.keys(ids) as (keyof typeof ids)[]) {
    as[who] = await h.signIn(`${who}@slh.test`);
    await as[who].put("/v1/me/teams/active", { teamId: team });
    as[who].team = team;
  }
});

afterAll(async () => {
  await h?.close();
});

describe("Site console (ac-3)", () => {
  it("is for site admins only and validates the reason", async () => {
    expect((await as.member.get(BASE)).status).toBe(403);
    expect((await as.member.post(BASE, { reason: REASON })).status).toBe(403);
    expect((await as.admin.post(BASE, { reason: "short" })).status).toBe(400);
    expect((await as.admin.post(BASE, { reason: REASON, teamId: team })).status).toBe(400);
  });

  it("needs a second site admin to place and to release; every step audited in the Site log", async () => {
    const id = await requestHold();
    expect((await as.admin.get(BASE)).json).toMatchObject({ active: false });
    const self = await as.admin.post(`${BASE}/${id}/approve`);
    expect(self.status).toBe(403);
    expect(self.json.code).toBe("self_approval_forbidden");
    expect((await as.admin.post(`${BASE}/${id}/deny`)).json.code).toBe("cannot_deny_own");

    const placed = await as.owner.post(`${BASE}/${id}/approve`);
    expect(placed.status).toBe(200);
    expect(placed.json.hold).toMatchObject({ status: "active", selfApproved: false });
    expect(placed.json.hold.approvedBy.id).toBe(ids.owner);
    const list = await as.owner.get(BASE);
    expect(list.json.active).toBe(true);
    expect(list.json.holds[0].actions).toMatchObject({ requestRelease: true, approve: false });

    expect(
      (await as.admin.post(`${BASE}/${id}/release`, { reason: "Matter settled" })).status,
    ).toBe(200);
    // Still in force until a second admin approves; the requester can't.
    expect((await as.admin.get(BASE)).json.active).toBe(true);
    const selfRelease = await as.admin.post(`${BASE}/${id}/release/approve`);
    expect(selfRelease.json.code).toBe("release_self_approval_forbidden");
    expect((await as.owner.post(`${BASE}/${id}/release/approve`)).json.hold.status).toBe(
      "released",
    );
    expect((await as.admin.get(BASE)).json.active).toBe(false);

    const events = await auditFor(id);
    expect(events.map((e) => [e.action, e.actor_id, e.team_id])).toEqual([
      ["governance.site_legal_hold.requested", ids.admin, null],
      ["governance.site_legal_hold.placed", ids.owner, null],
      ["governance.site_legal_hold.release_requested", ids.admin, null],
      ["governance.site_legal_hold.released", ids.owner, null],
    ]);
    // The id only (and the self-approval flag): never the reason.
    expect(JSON.stringify(events.map((e) => e.target))).not.toContain("matter");
  });

  it("is denied by another admin, withdrawn by its requester, and a release can be turned down", async () => {
    const denied = await requestHold();
    expect((await as.owner.post(`${BASE}/${denied}/deny`)).json.hold.status).toBe("denied");
    const withdrawn = await requestHold();
    expect((await as.owner.post(`${BASE}/${withdrawn}/withdraw`)).json.code).toBe("not_requester");
    expect((await as.admin.post(`${BASE}/${withdrawn}/withdraw`)).json.hold.status).toBe(
      "withdrawn",
    );
    const id = await place();
    try {
      await as.admin.post(`${BASE}/${id}/release`, { reason: "Matter settled" });
      expect((await as.owner.post(`${BASE}/${id}/release/deny`)).json.hold.release).toBeNull();
      await as.admin.post(`${BASE}/${id}/release`, { reason: "Matter settled" });
      expect((await as.admin.post(`${BASE}/${id}/release/withdraw`)).json.hold.status).toBe(
        "active",
      );
      expect((await auditFor(id)).map((e) => e.action)).toContain(
        "governance.site_legal_hold.release_denied",
      );
    } finally {
      await release(id);
    }
    expect((await auditFor(denied)).map((e) => e.action)).toEqual([
      "governance.site_legal_hold.requested",
      "governance.site_legal_hold.denied",
    ]);
  });
});

describe("what a Site-wide hold freezes (ac-2)", () => {
  it("an edit past the version cap succeeds and prunes nothing; after release the next edit prunes", async () => {
    const item = await siteItem();
    const id = await place();
    // Checked before pruning: no delete is even tried, so none meets the KH001 guard.
    const kept = vi.spyOn(logger, "info");
    try {
      await editStatement(item, 1, 6);
      expect(await versionsOf(item)).toEqual([1, 2, 3, 4, 5, 6, 7]);
      expect(kept.mock.calls.filter((c) => c[1] === "memory version kept past the cap")).toEqual(
        [],
      );
    } finally {
      kept.mockRestore();
      await release(id);
    }
    await editStatement(item, 7, 1);
    expect(await versionsOf(item)).toEqual([4, 5, 6, 7, 8]);
  });

  it("a Workspace hold no longer suspends Site pruning (the Site-wide hold does)", async () => {
    const item = await siteItem();
    const hold =
      (
        await h.admin.query<{ id: string }>(
          `INSERT INTO legal_holds (team_id, user_id, reason, placed_by) VALUES ($1, NULL, 'matter', $2) RETURNING id`,
          [team, ids.admin],
        )
      ).rows[0]?.id ?? "";
    await h.admin.query(
      `UPDATE legal_holds SET status = 'active', approved_by = $2 WHERE id = $1`,
      [hold, ids.owner],
    );
    try {
      await editStatement(item, 1, 6);
      expect(await versionsOf(item)).toEqual([3, 4, 5, 6, 7]);
    } finally {
      await h.admin.query(
        `UPDATE legal_holds SET release_requested_by = $2, release_requested_at = now(), release_reason = 'done' WHERE id = $1`,
        [hold, ids.admin],
      );
      await h.admin.query(
        `UPDATE legal_holds SET status = 'released', released_by = $2 WHERE id = $1`,
        [hold, ids.owner],
      );
    }
  });

  it("a Site purge or sweep is skipped under the hold, and a delete that slips past is refused", async () => {
    const item = await siteItem();
    const db = h.deps.database.db;
    const purge = () =>
      withSiteMemoryPurge(db, async (tx) => {
        await tx.execute(sql`DELETE FROM site_memory_items WHERE id = ${item}`);
        return 1;
      });
    const id = await place();
    try {
      expect(await purge()).toEqual({ held: true });
      // The database guard (0225) backs it up as the app role.
      await expect(
        db.transaction((tx) => tx.execute(sql`DELETE FROM site_memory_items WHERE id = ${item}`)),
      ).rejects.toMatchObject({ cause: { code: "KH001" } });
      expect(await versionsOf(item)).toEqual([1]);
    } finally {
      await release(id);
    }
    expect(await purge()).toEqual({ held: false, value: 1 });
    expect(await versionsOf(item)).toEqual([]);
  });

  it("refuses to answer outside READ COMMITTED (review L2)", async () => {
    await expect(
      h.deps.database.db.transaction((tx) => siteMemoryHeld(tx), {
        isolationLevel: "repeatable read",
      }),
    ).rejects.toBeInstanceOf(SiteHoldIsolationError);
  });
});

describe("row fields of held Site items (review L3)", () => {
  const changes = async (item: string) =>
    (
      await h.admin.query<{ target: Record<string, unknown> }>(
        `SELECT target FROM audit_log
          WHERE action = 'memory.item.changed_under_hold' AND target->>'itemId' = $1 ORDER BY seq`,
        [item],
      )
    ).rows.map((r) => r.target);

  it("audits kind, tags, Policy and as_of before and after, only while a Site hold is in force", async () => {
    const item = await siteItem();
    await as.owner.patch(`${ITEMS}/site/${item}`, { expected_version: 1, tags: ["before"] });
    expect(await changes(item)).toEqual([]);
    const id = await place();
    try {
      const res = await as.owner.patch(`${ITEMS}/site/${item}`, {
        expected_version: 1,
        kind: "decision",
        tags: ["after"],
        as_of: "2026-11-01",
        policy: true,
      });
      expect(res.status, JSON.stringify(res.json)).toBe(200);
    } finally {
      await release(id);
    }
    expect(await changes(item)).toEqual([
      {
        itemId: item,
        version: 1,
        before: {
          kind: "fact",
          tagCount: 1,
          tagsHmac: tagsFingerprint(["before"]),
          policy: false,
          asOf: null,
        },
        after: {
          kind: "decision",
          tagCount: 1,
          tagsHmac: tagsFingerprint(["after"]),
          policy: true,
          asOf: "2026-11-01",
        },
      },
    ]);
    // Never the tag values.
    expect(JSON.stringify(await changes(item))).not.toMatch(/"(before|after)"\]/);
  });
});
