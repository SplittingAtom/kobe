import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  semanticMemoryErrorSchema,
  semanticMemoryItemDetailSchema,
  semanticMemoryListResponseSchema,
  type SemanticMemoryScope,
} from "@kobe/protocol";
import type { TestBrowser } from "./testing/browser.js";
import { openHarness, type Harness } from "./testing/harness.js";

/**
 * KOBE-378 (v1.3 SMA3): scope limits warn at 80% (curators told once per crossing) and block at
 * 100%, never evicting (ac-2); pins ≤ 10 per scope; the near-duplicate check on every save path,
 * `as_of`, and the version cap with pruning that skips versions runs used and items under a legal
 * hold (ac-4). Small limits come from the Site setting `memory.settings`.
 */
let h: Harness;
const teamA = randomUUID();
const teamB = randomUUID();
const ids = { site: "", site2: "", siteSteward: "", admin: "", steward: "", member: "" };
const as = {} as Record<keyof typeof ids, TestBrowser>;
const ITEMS = "/v1/memory/semantic/items";

const item = (scope: SemanticMemoryScope, id: string) => `${ITEMS}/${scope}/${id}`;
const detail = (json: unknown) => semanticMemoryItemDetailSchema.parse(json);
const errorOf = (r: { status: number; json: unknown }) => [
  r.status,
  semanticMemoryErrorSchema.parse(r.json).code,
];
const save = (
  who: TestBrowser,
  scope: SemanticMemoryScope,
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
/** Distinct statements, so the near-duplicate check stays quiet. */
const unique = (label: string) => `${label} ${randomUUID()} ${randomUUID()}`;

async function settings(value: Record<string, unknown>): Promise<void> {
  await h.admin.query(
    `INSERT INTO site_settings (key, value) VALUES ('memory.settings', $1)
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
    [JSON.stringify(value)],
  );
}

const nearFull = async (scope: "team" | "site") =>
  (
    await h.admin.query<{ team_id: string; user_id: string }>(
      `SELECT team_id, user_id FROM notifications
        WHERE kind = 'memory.scope.near_full' AND memory_scope = $1 ORDER BY created_at, user_id`,
      [scope],
    )
  ).rows;

beforeAll(async () => {
  h = await openHarness();
  ids.site = await h.createUser("site@limits.test", "admin");
  ids.site2 = await h.createUser("site2@limits.test", "admin");
  for (const who of ["siteSteward", "admin", "steward", "member"] as const)
    ids[who] = await h.createUser(`${who}@limits.test`);
  await h.admin.query(
    `INSERT INTO teams (id, slug, name) VALUES ($1, 'limits-a', 'A'), ($2, 'limits-b', 'B')`,
    [teamA, teamB],
  );
  await h.admin.query(
    `INSERT INTO team_members (team_id, user_id, role) VALUES
       ($1, $2, 'member'), ($1, $3, 'team_admin'), ($1, $4, 'member'), ($1, $5, 'member'),
       ($6, $7, 'member')`,
    [teamA, ids.site, ids.admin, ids.steward, ids.member, teamB, ids.siteSteward],
  );
  await h.admin.query(
    `INSERT INTO memory_stewards (team_id, user_id, granted_by) VALUES ($1, $2, $3)`,
    [teamA, ids.steward, ids.admin],
  );
  await h.admin.query(
    `INSERT INTO site_grants (user_id, "grant", granted_by) VALUES ($1, 'memory_steward', $2)`,
    [ids.siteSteward, ids.site],
  );
  // The Site steward works in Workspace B only (last used there).
  await h.admin.query(`INSERT INTO user_last_teams (user_id, team_id) VALUES ($1, $2)`, [
    ids.siteSteward,
    teamB,
  ]);
  for (const who of Object.keys(ids) as (keyof typeof ids)[]) {
    as[who] = await h.signIn(`${who}@limits.test`);
    const team = who === "siteSteward" ? teamB : teamA;
    if (who === "site2") continue;
    await as[who].put("/v1/me/teams/active", { teamId: team });
    as[who].team = team;
  }
  await settings({ scope_limits: { user: 5, portable: 3, team: 5, site: 5 }, version_cap: 5 });
});

afterAll(async () => {
  await h?.close();
});

describe("scope limits (ac-2)", () => {
  it("tells Workspace curators once per 80% crossing and blocks at 100% without evicting", async () => {
    const made: string[] = [];
    for (let n = 0; n < 3; n += 1)
      made.push(detail((await save(as.admin, "team", unique("fact"))).json).id);
    expect(await nearFull("team")).toEqual([]);
    made.push(detail((await save(as.admin, "team", unique("fact"))).json).id); // 4 of 5 = 80%
    const told = await nearFull("team");
    expect(told.map((n) => n.user_id).sort()).toEqual([ids.admin, ids.steward].sort());
    expect(told.every((n) => n.team_id === teamA)).toBe(true);
    made.push(detail((await save(as.steward, "team", unique("fact"))).json).id); // 5: no second notice
    expect(await nearFull("team")).toHaveLength(2);

    const full = await save(as.admin, "team", unique("fact"));
    expect(errorOf(full)).toEqual([409, "memory_scope_full"]);
    expect(full.json.capacity).toEqual({ count: 5, max: 5, needed: 1 });
    const list = semanticMemoryListResponseSchema.parse(
      (await as.member.get(`${ITEMS}?scope=team`)).json,
    );
    expect(list.usage).toEqual({ count: 5, max: 5 });
    expect(list.items.map((i) => i.id).sort()).toEqual([...made].sort()); // nothing evicted

    // Superseding at the limit is room-neutral.
    const swapped = await save(as.admin, "team", unique("replacement"), { supersedes_id: made[0] });
    expect(swapped.status, JSON.stringify(swapped.json)).toBe(201);
    // Restore at the limit is refused; below the line and back up tells curators again.
    await as.admin.post(`${item("team", String(made[1]))}/archive`);
    await as.admin.post(`${item("team", String(made[2]))}/archive`);
    const back = await as.admin.post(`${item("team", String(made[1]))}/restore`);
    expect(back.status).toBe(200);
    expect(await nearFull("team")).toHaveLength(4);
    await as.admin.post(`${item("team", String(made[2]))}/restore`);
    expect(errorOf(await as.admin.post(`${item("team", String(made[0]))}/restore`))).toEqual([
      409,
      "memory_item_inactive",
    ]);
    await as.admin.post(`${item("team", String(made[3]))}/archive`);
    await save(as.admin, "team", unique("refill"));
    expect(errorOf(await as.admin.post(`${item("team", String(made[3]))}/restore`))).toEqual([
      409,
      "memory_scope_full",
    ]);
  });

  it("tells Site curators in this Workspace and the rest where they work", async () => {
    for (let n = 0; n < 4; n += 1)
      expect((await save(as.site, "site", unique("site fact"))).status).toBe(201);
    const told = await nearFull("site");
    // site (member of A) here; the Site steward in B (last used); site2 belongs to no Workspace.
    expect(told.map((n) => [n.user_id, n.team_id]).sort()).toEqual(
      [
        [ids.site, teamA],
        [ids.siteSteward, teamB],
      ].sort(),
    );
  });

  it("caps each person's own scopes", async () => {
    for (let n = 0; n < 5; n += 1)
      expect((await save(as.member, "user", unique("mine"))).status).toBe(201);
    expect(errorOf(await save(as.member, "user", unique("mine")))).toEqual([
      409,
      "memory_scope_full",
    ]);
    // Another person's room is their own.
    expect((await save(as.steward, "user", unique("mine"))).status).toBe(201);
    for (let n = 0; n < 3; n += 1)
      expect((await save(as.member, "portable", unique("pref"))).status).toBe(201);
    expect(errorOf(await save(as.member, "portable", unique("pref")))).toEqual([
      409,
      "memory_scope_full",
    ]);
    expect(await nearFull("team")).toHaveLength(4); // personal scopes notify nobody
  });

  it("pins at most 10 active items per scope", async () => {
    await settings({ scope_limits: { user: 20, portable: 3, team: 5, site: 5 }, version_cap: 5 });
    const pinned: string[] = [];
    for (let n = 0; n < 10; n += 1) {
      const r = await save(as.steward, "user", unique("pin"), { pinned: n % 2 === 0 });
      const id = detail(r.json).id;
      if (n % 2 === 1)
        expect((await as.steward.post(`${item("user", id)}/pin`, { pinned: true })).status).toBe(
          200,
        );
      pinned.push(id);
    }
    expect(errorOf(await save(as.steward, "user", unique("pin"), { pinned: true }))).toEqual([
      409,
      "memory_pin_limit",
    ]);
    const spare = detail((await save(as.steward, "user", unique("spare"))).json).id;
    expect(errorOf(await as.steward.post(`${item("user", spare)}/pin`, { pinned: true }))).toEqual([
      409,
      "memory_pin_limit",
    ]);
    await as.steward.post(`${item("user", String(pinned[0]))}/archive`); // archiving unpins
    expect((await as.steward.post(`${item("user", spare)}/pin`, { pinned: true })).status).toBe(
      200,
    );
  });
});

describe("near-duplicates, as_of and tags (ac-4)", () => {
  it("warns on a near-duplicate on create, edit and Undo; Save anyway is audited", async () => {
    await settings({ scope_limits: { user: 50, portable: 3, team: 50, site: 50 }, version_cap: 5 });
    const base = detail(
      (await save(as.admin, "team", "The staging database is refreshed every Monday morning")).json,
    );
    const dup = await save(
      as.admin,
      "team",
      "The staging database is refreshed every Monday morning.",
    );
    expect(errorOf(dup)).toEqual([409, "memory_lint_warning"]);
    expect(dup.json.warnings.map((w: { code: string }) => w.code)).toEqual(["near_duplicate"]);
    expect(dup.json.duplicates[0]).toMatchObject({ id: base.id, version: 1 });
    // Another scope is not compared.
    expect(
      (await save(as.member, "user", "The staging database is refreshed every Monday morning."))
        .status,
    ).toBe(201);

    const anyway = await save(
      as.admin,
      "team",
      "The staging database is refreshed every Monday morning.",
      {
        overrides: { lint: true },
      },
    );
    expect(anyway.status).toBe(201);
    const saved = detail(anyway.json);
    expect(saved.versions[0]?.lint_override).toBe(true);
    const audit = await h.admin.query(
      `SELECT team_id, target FROM audit_log WHERE action = 'memory.lint.override'`,
    );
    expect(audit.rows).toEqual([
      {
        team_id: teamA,
        target: { scope: "team", itemId: saved.id, version: 1, warnings: ["near_duplicate"] },
      },
    ]);

    // Edit path.
    const other = detail(
      (await save(as.admin, "team", unique("Unrelated note about parking"))).json,
    );
    expect(
      errorOf(
        await as.admin.patch(item("team", other.id), {
          expected_version: 1,
          statement: "The staging database is refreshed every Monday morning!",
        }),
      ),
    ).toEqual([409, "memory_lint_warning"]);
    // Undo path: version 1 of `edited` matches `base` again.
    const edited = detail(
      (await save(as.admin, "team", unique("Draft about the staging refresh"))).json,
    );
    await h.admin.query(`UPDATE semantic_memory_items SET status = 'archived' WHERE id = ANY($1)`, [
      [base.id, saved.id],
    ]);
    const e2 = await as.admin.patch(item("team", edited.id), {
      expected_version: 1,
      statement: "The staging database is refreshed every Monday morning",
    });
    expect(e2.status).toBe(200);
    await as.admin.patch(item("team", edited.id), {
      expected_version: 2,
      statement: unique("Something else entirely"),
    });
    await h.admin.query(`UPDATE semantic_memory_items SET status = 'active' WHERE id = $1`, [
      base.id,
    ]);
    expect(
      errorOf(
        await as.admin.post(`${item("team", edited.id)}/revert`, {
          version: 2,
          expected_version: 3,
        }),
      ),
    ).toEqual([409, "memory_lint_warning"]);
  });

  it("stores as_of and lowercase tags", async () => {
    const r = detail(
      (
        await save(as.admin, "team", unique("Q3 revenue target"), {
          kind: "decision",
          as_of: "2026-10-01",
          tags: ["Finance", "finance", "Q3"],
        })
      ).json,
    );
    expect([r.as_of, r.tags]).toEqual(["2026-10-01", ["finance", "q3"]]);
    const cleared = detail(
      (await as.admin.patch(item("team", r.id), { expected_version: 1, as_of: null })).json,
    );
    expect([cleared.as_of, cleared.version]).toEqual([null, 1]);
    expect(
      (await save(as.member, "portable", unique("pref"), { as_of: "2026-10-01" })).status,
    ).toBe(400);
  });
});

describe("version cap (ac-4)", () => {
  const edit = async (who: TestBrowser, id: string, from: number, times: number) => {
    for (let n = 0; n < times; n += 1)
      expect(
        (
          await who.patch(item("team", id), {
            expected_version: from + n,
            statement: unique(`edit ${n}`),
          })
        ).status,
      ).toBe(200);
  };
  const versionsOf = async (id: string) =>
    (
      await h.admin.query<{ version: number }>(
        `SELECT version FROM semantic_memory_item_versions WHERE item_id = $1 ORDER BY version`,
        [id],
      )
    ).rows.map((r) => r.version);

  it("prunes the oldest versions past the cap, keeping any version a run used", async () => {
    const id = detail((await save(as.admin, "team", unique("capped"))).json).id;
    await edit(as.admin, id, 1, 1); // v2
    const thread =
      (
        await h.admin.query<{ id: string }>(
          `INSERT INTO threads (team_id, owner_user_id, title) VALUES ($1, $2, 'T') RETURNING id`,
          [teamA, ids.admin],
        )
      ).rows[0]?.id ?? "";
    const run =
      (
        await h.admin.query<{ id: string }>(
          `INSERT INTO runs (team_id, thread_id, trigger, status, started_at) VALUES ($1, $2, 'user', 'running', now()) RETURNING id`,
          [teamA, thread],
        )
      ).rows[0]?.id ?? "";
    await h.admin.query(
      `INSERT INTO run_memory_items (team_id, run_id, item_id, version) VALUES ($1, $2, $3, 2)`,
      [teamA, run, id],
    );
    await edit(as.admin, id, 2, 6); // v3..v8
    expect(await versionsOf(id)).toEqual([2, 5, 6, 7, 8]);
    const d = detail((await as.admin.get(item("team", id))).json);
    expect(d.versions.map((v) => v.version)).toEqual([8, 7, 6, 5, 2]);
    // Undo to a pruned version is refused; to the kept one works.
    expect(
      (await as.admin.post(`${item("team", id)}/revert`, { version: 3, expected_version: 8 }))
        .status,
    ).toBe(400);
    expect(
      (
        await as.admin.post(`${item("team", id)}/revert`, {
          version: 2,
          expected_version: 8,
          overrides: { lint: true },
        })
      ).status,
    ).toBe(200);
  });

  it("prunes portable and Site versions too", async () => {
    await settings({
      scope_limits: { user: 50, portable: 50, team: 50, site: 50 },
      version_cap: 5,
    });
    for (const [scope, who] of [
      ["portable", as.member],
      ["site", as.site],
    ] as const) {
      const id = detail((await save(who, scope, unique("capped"))).json).id;
      for (let n = 0; n < 6; n += 1)
        expect(
          (
            await who.patch(item(scope, id), {
              expected_version: 1 + n,
              statement: unique(`edit ${n}`),
            })
          ).status,
        ).toBe(200);
      const d = detail((await who.get(item(scope, id))).json);
      expect(
        d.versions.map((v) => v.version),
        scope,
      ).toEqual([7, 6, 5, 4, 3]);
    }
  });

  it("a Workspace-wide hold keeps portable versions of that Workspace's members only (KOBE-386 Q2)", async () => {
    await settings({
      scope_limits: { user: 50, portable: 50, team: 50, site: 50 },
      version_cap: 5,
    });
    const hold =
      (
        await h.admin.query<{ id: string }>(
          `INSERT INTO legal_holds (team_id, user_id, reason, placed_by) VALUES ($1, NULL, 'matter B', $2) RETURNING id`,
          [teamB, ids.site],
        )
      ).rows[0]?.id ?? "";
    await h.admin.query(
      `UPDATE legal_holds SET status = 'active', approved_by = $2 WHERE id = $1`,
      [hold, ids.site2],
    );
    const sevenVersions = async (who: TestBrowser) => {
      const id = detail((await save(who, "portable", unique("pref"))).json).id;
      for (let n = 0; n < 6; n += 1)
        expect(
          (
            await who.patch(item("portable", id), {
              expected_version: 1 + n,
              statement: unique(`edit ${n}`),
            })
          ).status,
        ).toBe(200);
      return detail((await who.get(item("portable", id))).json).versions.map((v) => v.version);
    };
    try {
      // The Site steward is a member of the held Workspace B; the member works in A only.
      expect(await sevenVersions(as.siteSteward)).toEqual([7, 6, 5, 4, 3, 2, 1]);
      expect(await sevenVersions(as.member)).toEqual([7, 6, 5, 4, 3]);
    } finally {
      await h.admin.query(
        `UPDATE legal_holds SET release_requested_by = $2, release_requested_at = now(), release_reason = 'done' WHERE id = $1`,
        [hold, ids.site],
      );
      await h.admin.query(
        `UPDATE legal_holds SET status = 'released', released_by = $2 WHERE id = $1`,
        [hold, ids.site2],
      );
    }
  });

  it("keeps every version while a legal hold covers the item", async () => {
    const id = detail((await save(as.admin, "team", unique("held"))).json).id;
    const hold =
      (
        await h.admin.query<{ id: string }>(
          `INSERT INTO legal_holds (team_id, user_id, reason, placed_by) VALUES ($1, NULL, 'matter', $2) RETURNING id`,
          [teamA, ids.site],
        )
      ).rows[0]?.id ?? "";
    await h.admin.query(
      `UPDATE legal_holds SET status = 'active', approved_by = $2 WHERE id = $1`,
      [hold, ids.site2],
    );
    try {
      await edit(as.admin, id, 1, 6);
      expect(await versionsOf(id)).toEqual([1, 2, 3, 4, 5, 6, 7]);
    } finally {
      await h.admin.query(
        `UPDATE legal_holds SET release_requested_by = $2, release_requested_at = now(), release_reason = 'done' WHERE id = $1`,
        [hold, ids.site],
      );
      await h.admin.query(
        `UPDATE legal_holds SET status = 'released', released_by = $2 WHERE id = $1`,
        [hold, ids.site2],
      );
    }
    // After release the next write prunes back to the cap.
    await edit(as.admin, id, 7, 1);
    expect(await versionsOf(id)).toEqual([4, 5, 6, 7, 8]);
  });
});
