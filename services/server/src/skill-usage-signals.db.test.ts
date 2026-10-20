import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { TestBrowser } from "./testing/browser.js";
import { openHarness, type Harness } from "./testing/harness.js";
import { closedWindow, ensureUsageSnapshot, forgetUsageSnapshot } from "./skills/usage-snapshot.js";

/**
 * KOBE-339 (SK26): usage signals of catalog skills from the stored snapshot of the last closed
 * 30-day window, with the minimum-count rule (3 teams other than the viewer's teams now, 20
 * ratings, no dominant team; own team: 3 members other than the viewer), role-appropriate views,
 * no team names or ids anywhere, and fixed windows that can't be differenced.
 */
const WINDOW = closedWindow(new Date());
/** A day into the closed window, a day before it, or now (the current, open period). */
const at = (where: "in" | "before" | "current") =>
  where === "current"
    ? new Date().toISOString()
    : new Date(
        new Date(WINDOW.from).getTime() + (where === "in" ? 1 : -1) * 86_400_000,
      ).toISOString();
let h: Harness;
const NAME = "usage-report";
let skillId = "";
const teams = Array.from({ length: 5 }, () => randomUUID());
const registryTeam = randomUUID();
const TEAM_NAMES = teams.map((_, i) => `Secret-Team-${i + 1}`);
const ids: Record<string, string> = {};
const as: Record<string, TestBrowser> = {};
const bodies: string[] = [];

async function user(key: string, siteRole?: "admin") {
  ids[key] = await h.createUser(`${key.toLowerCase()}@usage.test`, siteRole);
}

async function member(team: string, key: string, role = "member") {
  await h.admin.query(`INSERT INTO team_members (team_id, user_id, role) VALUES ($1, $2, $3)`, [
    team,
    ids[key],
    role,
  ]);
}

/** A run in `team` by `key` that read the skill at `semver`, in the closed window by default. */
async function run(
  team: string,
  key: string,
  semver: string,
  opts: {
    when?: "in" | "before" | "current";
    ratedBy?: string;
    rating?: "up" | "down";
    flag?: string;
  } = {},
) {
  const thread = randomUUID();
  const when = at(opts.when ?? "in");
  await h.admin.query(
    `INSERT INTO threads (team_id, id, owner_user_id, title${opts.flag ? `, ${opts.flag}` : ""})
     VALUES ($1, $2, $3, 't'${opts.flag ? ", true" : ""})`,
    [team, thread, ids[key]],
  );
  const r = await h.admin.query<{ id: string }>(
    `INSERT INTO runs (team_id, thread_id, trigger, status, started_at, ended_at, created_at,
       skill_refs, skills_used)
     VALUES ($1, $2, 'user', 'completed', now(), now(), $3::timestamptz,
       $4::jsonb, $5::jsonb)
     RETURNING id`,
    [
      team,
      thread,
      when,
      JSON.stringify([{ name: NAME, source: "catalog", sha256: "a".repeat(64), semver }]),
      JSON.stringify([{ tool_call_id: "c1", name: NAME, source: "catalog" }]),
    ],
  );
  if (opts.ratedBy)
    await h.admin.query(
      `INSERT INTO answer_feedback (team_id, thread_id, run_id, user_id, rating, created_at,
         updated_at)
       VALUES ($1, $2, $3, $4, $5, now(), now())`,
      [team, thread, r.rows[0]?.id, ids[opts.ratedBy], opts.rating ?? "up"],
    );
}

const [t1, t2, t3, t4, t5] = teams as [string, string, string, string, string];

beforeAll(async () => {
  h = await openHarness();
  for (const k of ["u1", "v1", "admin1", "u2", "u4", "both", "maintainer", "outsider", "u5"])
    await user(k);
  for (let i = 1; i <= 5; i += 1) await user(`m3_${i}`);
  await user("admin3");
  await user("siteAdmin", "admin");
  for (const [i, team] of teams.entries())
    await h.admin.query(`INSERT INTO teams (id, slug, name) VALUES ($1, $2, $3)`, [
      team,
      `usage-${i}`,
      TEAM_NAMES[i],
    ]);
  await h.admin.query(
    `INSERT INTO teams (id, slug, name, registry) VALUES ($1, 'usage-reg', 'Secret-Registry', true)`,
    [registryTeam],
  );
  await member(t1, "u1");
  await member(t1, "v1");
  await member(t1, "admin1", "team_admin");
  await member(t1, "both");
  await member(t2, "both");
  await member(t2, "u2");
  for (let i = 1; i <= 5; i += 1) await member(t3, `m3_${i}`);
  await member(t3, "admin3", "team_admin");
  await member(t4, "u4");
  await member(t5, "u5");
  await member(registryTeam, "u5");

  const s = await h.admin.query<{ id: string }>(
    `INSERT INTO registry_skills (name, summary) VALUES ($1, 'Usage.') RETURNING id`,
    [NAME],
  );
  skillId = s.rows[0]?.id as string;
  await h.admin.query(`INSERT INTO registry_maintainers (skill_id, user_id) VALUES ($1, $2)`, [
    skillId,
    ids.maintainer,
  ]);
  const v: Record<string, string> = {};
  for (const [seq, semver] of ["1.0.0", "2.0.0"].entries()) {
    const r = await h.admin.query<{ id: string }>(
      `INSERT INTO registry_versions (skill_id, semver, seq, runtime_hash, package_hash,
         runtime_storage_key, runtime_size_bytes, manifest, provenance, source, scan, verdict,
         submitted_by, state, reviewed_by, approved_at)
       VALUES ($1, $2, $3, $4, $4, 'k', 1, '{}', '{}', '{}', '{"findings": []}', 'pass', $5,
         'approved', $6, now())
       RETURNING id`,
      [skillId, semver, seq + 1, String(seq).repeat(64), ids.maintainer, ids.siteAdmin],
    );
    v[semver] = r.rows[0]?.id as string;
  }
  for (const [team, semver] of [
    [t1, "1.0.0"],
    [t2, "1.0.0"],
    [t3, "1.0.0"],
    [t4, "2.0.0"],
  ] as const)
    await h.admin.query(
      `INSERT INTO team_skill_installs (team_id, skill_id, version_id, pin_mode, access,
         installed_by)
       VALUES ($1, $2, $3, 'pinned', 'available', $4)`,
      [team, skillId, v[semver], ids.maintainer],
    );
  await h.admin.query(
    `INSERT INTO team_skill_optouts (team_id, skill_id, opted_out_by) VALUES ($1, $2, $3)`,
    [t5, skillId, ids.u5],
  );

  // Team 1: two members' runs, one rating. Team 2: seven rated runs. Team 3: seven runs rated by
  // five members. Team 4: seven runs at 2.0.0, one thumbs down.
  await run(t1, "u1", "1.0.0", { ratedBy: "u1" });
  await run(t1, "v1", "1.0.0");
  for (let i = 0; i < 7; i += 1) await run(t2, "u2", "1.0.0", { ratedBy: "u2" });
  for (let i = 0; i < 7; i += 1)
    await run(t3, `m3_${(i % 3) + 1}`, "1.0.0", { ratedBy: `m3_${(i % 5) + 1}` });
  for (let i = 0; i < 7; i += 1)
    await run(t4, "u4", "2.0.0", { ratedBy: "u4", rating: i === 0 ? "down" : "up" });
  // Not counted: a run of the open period, one before the window, the Registry team, a test chat.
  await run(t5, "u5", "1.0.0", { when: "current", ratedBy: "u5" });
  await run(t5, "u5", "1.0.0", { when: "before" });
  await run(registryTeam, "u5", "1.0.0", { ratedBy: "u5" });
  await run(t5, "u5", "1.0.0", { flag: "skill_test" });

  for (const [key, team] of [
    ["v1", t1],
    ["admin1", t1],
    ["both", t1],
    ["admin3", t3],
    ["maintainer", undefined],
    ["outsider", undefined],
    ["siteAdmin", undefined],
  ] as const) {
    as[key] = await h.signIn(`${key.toLowerCase()}@usage.test`);
    if (team) {
      expect((await as[key].put("/v1/me/teams/active", { teamId: team })).status).toBe(200);
      (as[key] as TestBrowser).team = team;
    }
  }
  forgetUsageSnapshot();
  // Two replicas at once: one computes and stores the window, the other finds it taken.
  const stored = await Promise.all([
    ensureUsageSnapshot(h.deps.database),
    ensureUsageSnapshot(h.deps.database),
  ]);
  expect(stored.filter(Boolean)).toHaveLength(1);
});

afterAll(async () => {
  await h?.close();
});

async function get(key: string, path: string) {
  const r = await (as[key] as TestBrowser).get(path);
  bodies.push(JSON.stringify(r.json));
  return r;
}

async function card(key: string) {
  const r = await get(key, "/v1/skills/catalog");
  expect(r.status, JSON.stringify(r.json)).toBe(200);
  return (r.json.skills as Record<string, unknown>[]).find((s) => s.name === NAME);
}

describe("members see site-wide numbers under the minimum-count rule (ac-1, ac-3)", () => {
  it("shows teams, members and the thumbs share from three teams other than the viewer's", async () => {
    // Four teams installed; members u1, v1, u2, m3_1–3, u4; 22 ratings, 21 from teams 2–4.
    expect(await card("v1")).toMatchObject({
      teamsInstalled: 4,
      usage: { members: 7, thumbsUp: 0.95 },
    });
    const d = await get("v1", `/v1/skills/catalog/${skillId}`);
    expect(d.json).toMatchObject({ teamsInstalled: 4, usage: { members: 7 } });
    expect(d.json.usageWindow).toEqual(WINDOW);
  });

  it("leaves every team the viewer belongs to out of the count", async () => {
    // "both" is in teams 1 and 2: teams 3 and 4 are too few to show anything.
    expect(await card("both")).toMatchObject({
      teamsInstalled: "few",
      usage: { members: "few", thumbsUp: "few" },
    });
  });

  it("reads the viewer's teams now, not when the window was computed (review M3)", async () => {
    await member(t3, "v1");
    expect(await card("v1")).toMatchObject({ teamsInstalled: "few" });
  });

  it("keeps a team the viewer left since the window opened as theirs (340 review N1)", async () => {
    // Team 3's admin removes v1 again (audited): joining, reading and leaving gains nothing.
    const removed = await (as.admin3 as TestBrowser).request(
      "DELETE",
      `/v1/team/members/${ids.v1}`,
    );
    expect(removed.status, JSON.stringify(removed.json)).toBeLessThan(300);
    expect(await card("v1")).toMatchObject({ teamsInstalled: "few" });
  });
});

describe("Team admins see their own team (ac-3)", () => {
  it("runs and members on three members other than the viewer; thumbs on five raters", async () => {
    // Team 1: two members used it: few, and the version table is withheld.
    const t1Usage = await get("admin1", "/v1/team/skills/usage");
    expect(t1Usage.status, JSON.stringify(t1Usage.json)).toBe(200);
    expect(t1Usage.json.skills).toEqual([
      expect.objectContaining({
        name: NAME,
        runs: "few",
        members: "few",
        thumbs: { enough: false },
        versions: null,
      }),
    ]);
    const t3Usage = await get("admin3", "/v1/team/skills/usage");
    expect(t3Usage.json.skills[0]).toMatchObject({
      runs: 7,
      members: 3,
      thumbs: { enough: true, up: 7, down: 0 },
      versions: [{ semver: "1.0.0", runs: 7, members: 3 }],
    });
    expect((await get("v1", "/v1/team/skills/usage")).status).toBe(403);
  });
});

describe("maintainers and Site admins see per version (ac-3, ac-4)", () => {
  it("withholds a version column a hidden cell could be read from", async () => {
    for (const key of ["maintainer", "siteAdmin"]) {
      const u = await get(key, `/v1/skills/catalog/${skillId}/usage`);
      expect(u.status, JSON.stringify(u.json)).toBe(200);
      expect(u.json).toMatchObject({
        totals: { teamsInstalled: 4, members: 7, runs: 23, optOuts: "few" },
        versions: ["2.0.0", "1.0.0", "other"],
        // 2.0.0 runs in team 4 only: shown, it would give team 4 away by subtraction.
        perVersion: { teamsRunning: null, runs: null, members: null, thumbsUp: null },
      });
    }
    expect((await get("outsider", `/v1/skills/catalog/${skillId}/usage`)).status).toBe(403);
    expect((await get("v1", `/v1/skills/catalog/${skillId}/usage`)).status).toBe(403);
  });

  it("takes no window: fixed windows only", async () => {
    for (const path of [
      `/v1/skills/catalog/${skillId}/usage?window=7`,
      `/v1/skills/catalog/${skillId}/usage?from=2026-01-01`,
    ])
      expect((await get("maintainer", path)).status, path).toBe(400);
    expect((await get("admin1", "/v1/team/skills/usage?window=90")).status).toBe(400);
  });

  it("never changes a closed window, on any replica or after a restart (review M1, M2)", async () => {
    const before = await get("maintainer", `/v1/skills/catalog/${skillId}/usage`);
    await run(t2, "u2", "1.0.0");
    // A restart (nothing cached) and another replica's check find the window stored.
    forgetUsageSnapshot();
    expect(await ensureUsageSnapshot(h.deps.database)).toBe(false);
    const after = await get("maintainer", `/v1/skills/catalog/${skillId}/usage`);
    expect(after.json).toEqual(before.json);
    const rows = await h.admin.query(`SELECT window_start FROM skill_usage_snapshots`);
    expect(rows.rows).toHaveLength(1);
  });
});

describe("no team names or ids (ac-2)", () => {
  it("no usage answer names a team or carries another team's id", () => {
    expect(bodies.length).toBeGreaterThan(5);
    for (const body of bodies) {
      for (const name of [...TEAM_NAMES, "Secret-Registry"]) expect(body).not.toContain(name);
      for (const id of [t2, t3, t4, t5, registryTeam]) expect(body).not.toContain(id);
    }
  });
});
