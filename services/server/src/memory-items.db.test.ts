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
 * KOBE-378 (v1.3 SMA3): the item store behind `/v1/memory/semantic/items` over the Workspace,
 * portable and Site tables. Versions, Undo, archive/restore, supersede and pin round-trip on every
 * table (ac-1); Policy is Site admins only, ≤ 25 items and ≤ 2 KiB (ac-3); portable saves need
 * `confirm_portable` (ac-3); personal items never cross people and Workspace items never cross
 * Workspaces. Limits, duplicates, `as_of` and the version cap: memory-items-limits.db.test.ts.
 */
let h: Harness;
const teamA = randomUUID();
const teamB = randomUUID();
const ids = {
  site: "",
  site2: "",
  steward: "",
  siteSteward: "",
  admin: "",
  member: "",
  other: "",
  outsider: "",
};
const as = {} as Record<keyof typeof ids, TestBrowser>;
const ITEMS = "/v1/memory/semantic/items";
/** Distinct statements, so the near-duplicate check stays quiet. */
const unique = (label: string) => `${label} ${randomUUID()}`;

const audit = async (action: string) =>
  (
    await h.admin.query<{
      team_id: string | null;
      actor_id: string;
      target: Record<string, unknown>;
    }>(`SELECT team_id, actor_id, target FROM audit_log WHERE action = $1 ORDER BY seq`, [action])
  ).rows;

const create = (who: TestBrowser, body: Record<string, unknown>) => who.post(ITEMS, body);
const item = (scope: SemanticMemoryScope, id: string) => `${ITEMS}/${scope}/${id}`;
const bodyOf = (
  scope: SemanticMemoryScope,
  statement: string,
  extra: Record<string, unknown> = {},
) => ({
  scope,
  kind: scope === "portable" ? "preference" : "fact",
  statement,
  ...(scope === "portable" ? { confirm_portable: true } : {}),
  ...extra,
});
const detail = (json: unknown) => semanticMemoryItemDetailSchema.parse(json);
const errorOf = (r: { status: number; json: unknown }) => [
  r.status,
  semanticMemoryErrorSchema.parse(r.json).code,
];

beforeAll(async () => {
  h = await openHarness();
  ids.site = await h.createUser("site@items.test", "admin");
  ids.site2 = await h.createUser("site2@items.test", "admin");
  for (const who of ["steward", "siteSteward", "admin", "member", "other", "outsider"] as const)
    ids[who] = await h.createUser(`${who}@items.test`);
  await h.admin.query(
    `INSERT INTO teams (id, slug, name) VALUES ($1, 'items-a', 'A'), ($2, 'items-b', 'B')`,
    [teamA, teamB],
  );
  await h.admin.query(
    `INSERT INTO team_members (team_id, user_id, role) VALUES
       ($1, $2, 'member'), ($1, $3, 'member'), ($1, $4, 'member'), ($1, $5, 'team_admin'),
       ($1, $6, 'member'), ($1, $7, 'member'), ($8, $9, 'member'), ($8, $6, 'member'), ($1, $10, 'member')`,
    [
      teamA,
      ids.site,
      ids.steward,
      ids.siteSteward,
      ids.admin,
      ids.member,
      ids.other,
      teamB,
      ids.outsider,
      ids.site2,
    ],
  );
  await h.admin.query(
    `INSERT INTO memory_stewards (team_id, user_id, granted_by) VALUES ($1, $2, $3)`,
    [teamA, ids.steward, ids.admin],
  );
  await h.admin.query(
    `INSERT INTO site_grants (user_id, "grant", granted_by) VALUES ($1, 'memory_steward', $2)`,
    [ids.siteSteward, ids.site],
  );
  for (const who of Object.keys(ids) as (keyof typeof ids)[]) {
    as[who] = await h.signIn(`${who}@items.test`);
    const team = who === "outsider" ? teamB : teamA;
    await as[who].put("/v1/me/teams/active", { teamId: team });
    as[who].team = team;
  }
});

afterAll(async () => {
  await h?.close();
});

/** Who saves each scope in the round trip. */
const SAVER: Record<SemanticMemoryScope, keyof typeof ids> = {
  user: "member",
  portable: "member",
  team: "admin",
  site: "site",
};

describe("item lifecycle on all three tables (ac-1)", () => {
  it.each(["user", "portable", "team", "site"] as const)(
    "%s: versions, Undo, archive/restore, pin and supersede round-trip",
    async (scope) => {
      const who = as[SAVER[scope]];
      const made = await create(
        who,
        bodyOf(scope, `Original ${scope} statement about lunch`, { tags: ["Ops", "ops", "Food"] }),
      );
      expect(made.status, JSON.stringify(made.json)).toBe(201);
      const v1 = detail(made.json);
      expect(v1).toMatchObject({ scope, version: 1, status: "active", tags: ["ops", "food"] });

      const edited = await who.patch(item(scope, v1.id), {
        expected_version: 1,
        statement: `Edited ${scope} statement about dinner plans`,
      });
      expect(edited.status, JSON.stringify(edited.json)).toBe(200);
      expect(detail(edited.json).versions.map((v) => v.version)).toEqual([2, 1]);

      const stale = await who.patch(item(scope, v1.id), { expected_version: 1, tags: ["x"] });
      expect(errorOf(stale)).toEqual([409, "memory_version_conflict"]);
      expect(stale.json.current_version).toBe(2);

      const undone = detail(
        (
          await who.post(`${item(scope, v1.id)}/revert`, {
            version: 1,
            expected_version: 2,
            overrides: { lint: true },
          })
        ).json,
      );
      expect(undone.version).toBe(3);
      expect(undone.statement).toBe(`Original ${scope} statement about lunch`);
      expect(undone.versions).toHaveLength(3);

      const pinned = detail((await who.post(`${item(scope, v1.id)}/pin`, { pinned: true })).json);
      expect(pinned.pinned).toBe(true);
      const archived = detail(
        (await who.post(`${item(scope, v1.id)}/archive`, { expected_version: 3 })).json,
      );
      expect([archived.status, archived.pinned, archived.versions.length]).toEqual([
        "archived",
        false,
        3,
      ]);
      expect(
        errorOf(await who.patch(item(scope, v1.id), { expected_version: 3, tags: ["y"] })),
      ).toEqual([409, "memory_item_inactive"]);
      const restored = detail((await who.post(`${item(scope, v1.id)}/restore`)).json);
      expect(restored.status).toBe("active");

      const next = await create(
        who,
        bodyOf(scope, `A newer ${scope} rule replacing the old one entirely`, {
          supersedes_id: v1.id,
        }),
      );
      expect(next.status, JSON.stringify(next.json)).toBe(201);
      const old = detail((await who.get(item(scope, v1.id))).json);
      expect([old.status, old.superseded_by]).toEqual(["superseded", detail(next.json).id]);
      expect(errorOf(await who.post(`${item(scope, v1.id)}/restore`))).toEqual([
        409,
        "memory_item_inactive",
      ]);

      // Audited in the team log (Workspace) or the site log (portable, Site); never the statement.
      const teamId = scope === "user" || scope === "team" ? teamA : null;
      for (const action of [
        "memory.item.created",
        "memory.item.updated",
        "memory.item.reverted",
        "memory.item.pinned",
        "memory.item.archived",
        "memory.item.restored",
        "memory.item.superseded",
      ]) {
        const rows = (await audit(action)).filter((r) => r.target.itemId === v1.id);
        expect(rows, action).toHaveLength(1);
        expect(rows[0]?.team_id, action).toBe(teamId);
        expect(JSON.stringify(rows[0]?.target)).not.toContain("statement about");
      }
    },
  );
});

describe("walls between people and Workspaces", () => {
  it("never shows or changes another person's user or portable items", async () => {
    const mine = detail(
      (await create(as.member, bodyOf("user", "My private note on the coffee machine"))).json,
    );
    const port = detail(
      (await create(as.member, bodyOf("portable", "I prefer answers in bullet points always")))
        .json,
    );
    for (const [scope, id] of [
      ["user", mine.id],
      ["portable", port.id],
    ] as const) {
      expect(errorOf(await as.other.get(item(scope, id)))).toEqual([404, "memory_item_not_found"]);
      expect(
        errorOf(await as.admin.patch(item(scope, id), { expected_version: 1, tags: ["x"] })),
      ).toEqual([404, "memory_item_not_found"]);
      expect(errorOf(await as.site.post(`${item(scope, id)}/archive`))).toEqual([
        404,
        "memory_item_not_found",
      ]);
      const list = semanticMemoryListResponseSchema.parse(
        (await as.other.get(`${ITEMS}?scope=${scope}`)).json,
      );
      expect(list.items.map((i) => i.id)).not.toContain(id);
    }
    // Portable items follow their owner into another Workspace; nobody else sees them there.
    const other = await h.signIn("member@items.test");
    await other.put("/v1/me/teams/active", { teamId: teamB });
    other.team = teamB;
    expect((await other.get(item("portable", port.id))).status).toBe(200);
    expect((await other.get(item("user", mine.id))).status).toBe(404);
    expect((await as.outsider.get(item("portable", port.id))).status).toBe(404);
  });

  it("keeps Workspace items inside their Workspace", async () => {
    const shared = detail(
      (await create(as.admin, bodyOf("team", "Team A deploys on Tuesdays only"))).json,
    );
    expect((await as.member.get(item("team", shared.id))).status).toBe(200);
    expect(errorOf(await as.outsider.get(item("team", shared.id)))).toEqual([
      404,
      "memory_item_not_found",
    ]);
    expect(
      errorOf(await as.outsider.post(`${item("team", shared.id)}/pin`, { pinned: true })),
    ).toEqual([404, "memory_item_not_found"]);
    const list = semanticMemoryListResponseSchema.parse(
      (await as.outsider.get(`${ITEMS}?scope=team`)).json,
    );
    expect(list.items).toEqual([]);
  });

  it("lets Team admins and Workspace stewards change Workspace items, not other members", async () => {
    const shared = detail(
      (await create(as.steward, bodyOf("team", "Stewards keep the runbook in the wiki"))).json,
    );
    expect(
      errorOf(await create(as.member, bodyOf("team", "Members cannot save shared facts here"))),
    ).toEqual([403, "memory_not_allowed"]);
    expect(errorOf(await as.member.post(`${item("team", shared.id)}/archive`))).toEqual([
      403,
      "memory_not_allowed",
    ]);
    expect((await as.admin.post(`${item("team", shared.id)}/pin`, { pinned: true })).status).toBe(
      200,
    );
    // Thread links on Workspace versions go to the author and curators only.
    const thread =
      (
        await h.admin.query<{ id: string }>(
          `INSERT INTO threads (team_id, owner_user_id, title) VALUES ($1, $2, 'T') RETURNING id`,
          [teamA, ids.steward],
        )
      ).rows[0]?.id ?? "";
    const linked = detail(
      (
        await create(
          as.steward,
          bodyOf("team", "The release checklist lives in the handbook", {
            source_thread_id: thread,
            source_entry_ids: ["e1"],
          }),
        )
      ).json,
    );
    expect(linked.versions[0]?.source_thread_id).toBe(thread);
    const seen = detail((await as.member.get(item("team", linked.id))).json);
    expect([seen.versions[0]?.source_thread_id, seen.versions[0]?.source_entry_ids]).toEqual([
      null,
      null,
    ]);
    // A thread of another Workspace is refused.
    const foreign =
      (
        await h.admin.query<{ id: string }>(
          `INSERT INTO threads (team_id, owner_user_id, title) VALUES ($1, $2, 'T') RETURNING id`,
          [teamB, ids.outsider],
        )
      ).rows[0]?.id ?? "";
    expect(
      (
        await create(
          as.steward,
          bodyOf("team", "Linked to a thread elsewhere entirely", { source_thread_id: foreign }),
        )
      ).status,
    ).toBe(400);
  });
});

describe("Site items and Policy (ac-3)", () => {
  it("lets Site stewards curate Site items but never set or change Policy", async () => {
    const plain = await create(
      as.siteSteward,
      bodyOf("site", "The Site's fiscal year starts in April"),
    );
    expect(plain.status, JSON.stringify(plain.json)).toBe(201);
    expect(
      errorOf(
        await create(
          as.siteSteward,
          bodyOf("site", "Stewards can't write Policy", { policy: true }),
        ),
      ),
    ).toEqual([403, "memory_not_allowed"]);
    expect(
      errorOf(
        await create(as.siteSteward, bodyOf("site", "Not even policy false", { policy: false })),
      ),
    ).toEqual([403, "memory_not_allowed"]);
    const pol = detail(
      (
        await create(
          as.site,
          bodyOf("site", "Never share customer names outside the company", {
            kind: "convention",
            policy: true,
          }),
        )
      ).json,
    );
    expect(pol.policy).toBe(true);
    expect(
      errorOf(
        await as.siteSteward.patch(item("site", pol.id), { expected_version: 1, tags: ["x"] }),
      ),
    ).toEqual([403, "memory_not_allowed"]);
    expect(errorOf(await as.siteSteward.post(`${item("site", pol.id)}/archive`))).toEqual([
      403,
      "memory_not_allowed",
    ]);
    expect(
      errorOf(
        await as.siteSteward.patch(item("site", detail(plain.json).id), {
          expected_version: 1,
          policy: true,
        }),
      ),
    ).toEqual([403, "memory_not_allowed"]);
    // Members read Site items without author ids; Team admins don't curate them.
    const seen = detail((await as.member.get(item("site", pol.id))).json);
    expect([seen.updated_by, seen.versions[0]?.actor_user_id]).toEqual([null, null]);
    expect(errorOf(await as.admin.post(`${item("site", pol.id)}/pin`, { pinned: false }))).toEqual([
      403,
      "memory_not_allowed",
    ]);
    // Policy is never pinned.
    expect(errorOf(await as.site.post(`${item("site", pol.id)}/pin`, { pinned: true }))).toEqual([
      409,
      "memory_policy_not_pinnable",
    ]);
    const pinnedPlain = detail(
      (await as.site.post(`${item("site", detail(plain.json).id)}/pin`, { pinned: true })).json,
    );
    expect(
      errorOf(
        await as.site.patch(item("site", pinnedPlain.id), { expected_version: 1, policy: true }),
      ),
    ).toEqual([409, "memory_policy_not_pinnable"]);
    expect((await audit("memory.policy.set")).length).toBe(0);
    const unpinned = await as.site.post(`${item("site", pinnedPlain.id)}/pin`, { pinned: false });
    expect(unpinned.status).toBe(200);
    expect(
      (await as.site.patch(item("site", pinnedPlain.id), { expected_version: 1, policy: true }))
        .status,
    ).toBe(200);
    expect(await audit("memory.policy.set")).toEqual([
      {
        team_id: null,
        actor_id: ids.site,
        target: { itemId: pinnedPlain.id, version: 1, policy: true },
      },
    ]);
    // Policy exists only on the Site.
    expect(
      (
        await as.admin.patch(
          item(
            "team",
            detail(
              (await create(as.admin, bodyOf("team", "Shared fact for the policy check"))).json,
            ).id,
          ),
          { expected_version: 1, policy: false },
        )
      ).status,
    ).toBe(400);
  });

  it("caps Policy at 25 items and 2 KiB of text", async () => {
    await h.admin.query(
      `UPDATE site_memory_items SET status = 'archived', pinned = false WHERE policy`,
    );
    const policy = (statement: string) =>
      create(as.site, bodyOf("site", statement, { policy: true, overrides: { lint: true } }));
    const long = (n: number) => `${String.fromCharCode(65 + n)} `.repeat(250).trim();
    for (let n = 0; n < 4; n += 1) expect((await policy(long(n))).status).toBe(201);
    // 4 × 499 bytes; one more of 60 bytes passes 2,048.
    expect(errorOf(await policy("x".repeat(60)))).toEqual([409, "memory_policy_budget_full"]);
    const list = semanticMemoryListResponseSchema.parse(
      (await as.site.get(`${ITEMS}?scope=site&policy=true`)).json,
    );
    expect(list.usage).toMatchObject({ policy_count: 4, policy_bytes: 4 * 499 });
    await h.admin.query(`UPDATE site_memory_items SET status = 'archived' WHERE policy`);
    for (let n = 0; n < 25; n += 1)
      expect((await policy(`Rule ${n}: ${randomUUID()}`)).status, String(n)).toBe(201);
    expect(errorOf(await policy("Rule twenty six"))).toEqual([409, "memory_policy_budget_full"]);
    // Restoring an archived Policy item counts too.
    const archived =
      (
        await h.admin.query<{ id: string }>(
          `SELECT id FROM site_memory_items WHERE policy AND status = 'archived' LIMIT 1`,
        )
      ).rows[0]?.id ?? "";
    expect(errorOf(await as.site.post(`${item("site", archived)}/restore`))).toEqual([
      409,
      "memory_policy_budget_full",
    ]);
    await h.admin.query(`UPDATE site_memory_items SET status = 'archived' WHERE policy`);
  });

  it("needs confirm_portable for a portable save", async () => {
    const r = await create(as.member, {
      scope: "portable",
      kind: "preference",
      statement: "Prefers dark mode everywhere",
    });
    expect(r.status).toBe(400);
    expect(
      (
        await create(as.member, {
          scope: "portable",
          kind: "fact",
          statement: "x",
          confirm_portable: true,
        })
      ).status,
    ).toBe(400);
  });

  it("follows the switches: memories off refuses, Policy stays readable with Site memories off", async () => {
    await h.admin.query(
      `UPDATE teams SET settings = jsonb_set(settings, '{memory}', '{"site_memories_enabled": false}') WHERE id = $1`,
      [teamA],
    );
    try {
      const list = semanticMemoryListResponseSchema.parse(
        (await as.member.get(`${ITEMS}?scope=site`)).json,
      );
      expect(list.items.every((i) => i.policy)).toBe(true);
      const plain =
        (
          await h.admin.query<{ id: string }>(
            `SELECT id FROM site_memory_items WHERE NOT policy LIMIT 1`,
          )
        ).rows[0]?.id ?? "";
      expect(errorOf(await as.member.get(item("site", plain)))).toEqual([403, "memory_disabled"]);
    } finally {
      await h.admin.query(`UPDATE teams SET settings = settings - 'memory' WHERE id = $1`, [teamA]);
    }
    await h.admin.query(
      `UPDATE teams SET settings = jsonb_set(settings, '{memory}', '{"memories_enabled": false}') WHERE id = $1`,
      [teamA],
    );
    try {
      expect(errorOf(await create(as.member, bodyOf("user", "Saved while memory is off")))).toEqual(
        [403, "memory_disabled"],
      );
      expect(errorOf(await as.member.get(`${ITEMS}?scope=user`))).toEqual([403, "memory_disabled"]);
    } finally {
      await h.admin.query(`UPDATE teams SET settings = settings - 'memory' WHERE id = $1`, [teamA]);
    }
  });
});

describe("portable and Site items without an active Workspace", () => {
  it("lets Site admins and stewards in no Workspace curate Site items; owners keep portable ones", async () => {
    await h.createUser("lone@items.test", "admin");
    const loneSteward = await h.createUser("lonesteward@items.test");
    await h.admin.query(
      `INSERT INTO site_grants (user_id, "grant", granted_by) VALUES ($1, 'memory_steward', $2)`,
      [loneSteward, ids.site],
    );
    const lone = await h.signIn("lone@items.test");
    const steward = await h.signIn("lonesteward@items.test");

    const made = await create(lone, bodyOf("site", unique("Site fact saved from no workspace")));
    expect(made.status, JSON.stringify(made.json)).toBe(201);
    const id = detail(made.json).id;
    expect(detail((await steward.get(item("site", id))).json).updated_by).not.toBeNull();
    const edited = await steward.patch(item("site", id), {
      expected_version: 1,
      statement: unique("Edited by a steward with no workspace"),
    });
    expect(edited.status, JSON.stringify(edited.json)).toBe(200);
    expect(
      errorOf(await steward.patch(item("site", id), { expected_version: 2, policy: true })),
    ).toEqual([403, "memory_not_allowed"]);
    const pol = await create(
      lone,
      bodyOf("site", unique("Policy from no workspace"), { policy: true }),
    );
    expect(pol.status, JSON.stringify(pol.json)).toBe(201);
    await h.admin.query(`UPDATE site_memory_items SET status = 'archived' WHERE id = $1`, [
      detail(pol.json).id,
    ]);
    const list = semanticMemoryListResponseSchema.parse(
      (await steward.get(`${ITEMS}?scope=site`)).json,
    );
    expect(list.items.map((i) => i.id)).toContain(id);

    const pref = await create(steward, bodyOf("portable", unique("Prefers short summaries")));
    expect(pref.status, JSON.stringify(pref.json)).toBe(201);
    expect((await steward.get(item("portable", detail(pref.json).id))).status).toBe(200);
    expect((await lone.get(item("portable", detail(pref.json).id))).status).toBe(404);

    // Workspace scopes still need one.
    for (const scope of ["user", "team"] as const) {
      const r = await create(lone, bodyOf(scope, unique("needs a workspace")));
      expect([r.status, r.json.code]).toEqual([400, "team_header_required"]);
      const read = await lone.get(`${ITEMS}?scope=${scope}`);
      expect([read.status, read.json.code]).toEqual([409, "no_active_team"]);
    }
  });
});
