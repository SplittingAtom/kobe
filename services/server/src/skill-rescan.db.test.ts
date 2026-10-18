import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { zipSync, strToU8 } from "fflate";
import { RULE_SET_VERSION } from "@kobe/skill-scanner";
import { withTeam } from "@kobe/db";
import { logger } from "./logger.js";
import { loadSkillFacts } from "./runs/resolver-input.js";
import { rescanOnce } from "./skills/rescan.js";
import { RawBody, type TestBrowser } from "./testing/browser.js";
import { openHarness, type Harness } from "./testing/harness.js";
import { MemoryObjects } from "./testing/memory-objects.js";

/**
 * KOBE-313 (SK32): rescans on a scanner rule-set change. One rescan per rule set across replicas
 * (lease); a version a rescan turns Block is suspended, omitted at resolve as `suspended`, and its
 * people are told; the Site console shows each rescan.
 */
let h: Harness;
const finance = randomUUID();
const ids = { admin: "", builder: "", member: "", site: "" };
const as = {} as Record<keyof typeof ids, TestBrowser>;

const ELF = [0x7f, 0x45, 0x4c, 0x46, 2, 1, 1, 0, 0, 0, 0, 0];
const PNG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0x0d];
/** An ELF hidden in a PNG: the pre-312 scanner skipped it as an asset, without a finding. */
const POLYGLOT = Uint8Array.from([...PNG, 1, 2, 3, ...ELF]);

const zipOf = (name: string, extra: Record<string, Uint8Array> = {}) =>
  new RawBody(
    zipSync({
      "SKILL.md": strToU8(
        `---\nname: ${name}\ndescription: Skill ${name}\n---\n# ${name}\nBody.\n`,
      ),
      ...extra,
    }),
    "application/zip",
  );

/** Rewrites a stored scan as the pre-KOBE-312 scanner left it: no findings, binaries skipped. */
async function asOldScan(table: "team_skill_reviews" | "personal_skill_scans", skillId: string) {
  await h.admin.query(
    `UPDATE ${table} SET findings = '[]', flagged = false, skipped = '["assets/logo.png"]',
       rule_set_version = NULL WHERE skill_id = $1`,
    [skillId],
  );
}

const rescan = (ruleSetVersion: string) =>
  rescanOnce({
    database: h.deps.database,
    blobs: h.deps.blobs as NonNullable<typeof h.deps.blobs>,
    log: logger,
    mailer: h.mailer,
    publicUrl: "https://kobe.test",
    ruleSetVersion,
  });

async function facts(userId: string, names: string[]) {
  return withTeam(h.deps.database.db, finance, (tx) =>
    loadSkillFacts(tx, {
      teamId: finance,
      userId,
      agentSkillNames: names,
      personalSkillsDisabled: false,
    }),
  );
}

beforeAll(async () => {
  h = await openHarness({ blobs: { objects: new MemoryObjects(), prefix: "kobe/" } });
  ids.admin = await h.createUser("admin@rescan.test");
  ids.builder = await h.createUser("builder@rescan.test");
  ids.member = await h.createUser("member@rescan.test");
  ids.site = await h.createUser("site@rescan.test", "admin");
  await h.admin.query(`INSERT INTO teams (id, slug, name) VALUES ($1, 'finance', 'Finance')`, [
    finance,
  ]);
  for (const [who, role] of [
    ["admin", "team_admin"],
    ["builder", "builder"],
    ["member", "member"],
  ] as const)
    await h.admin.query(`INSERT INTO team_members (team_id, user_id, role) VALUES ($1, $2, $3)`, [
      finance,
      ids[who],
      role,
    ]);
  for (const who of ["admin", "builder", "member", "site"] as const) {
    as[who] = await h.signIn(`${who}@rescan.test`);
    if (who === "site") continue;
    expect((await as[who].put("/v1/me/teams/active", { teamId: finance })).status).toBe(200);
    as[who].team = finance;
  }
});

afterAll(async () => {
  await h?.close();
});

let teamSkill = "";
let personalSkill = "";

describe("scans record their rule set", () => {
  it("stores the current rule set with every new scan", async () => {
    const up = await as.builder.post("/v1/skills?scope=team", zipOf("hidden-elf"));
    expect(up.status, JSON.stringify(up.json)).toBe(201);
    teamSkill = up.json.skill.id;
    const mine = await as.member.post("/v1/skills?scope=personal", zipOf("my-helper"));
    expect(mine.status, JSON.stringify(mine.json)).toBe(201);
    personalSkill = mine.json.skill.id;
    const team = await h.admin.query(
      `SELECT rule_set_version FROM team_skill_reviews WHERE skill_id = $1`,
      [teamSkill],
    );
    const personal = await h.admin.query(
      `SELECT rule_set_version FROM personal_skill_scans WHERE skill_id = $1`,
      [personalSkill],
    );
    expect(team.rows).toEqual([{ rule_set_version: RULE_SET_VERSION }]);
    expect(personal.rows).toEqual([{ rule_set_version: RULE_SET_VERSION }]);
  });
});

describe("rescan on a rule-set change", () => {
  it("rescans an old ELF-as-.png row once across replicas and suspends it (ac-1, ac-2)", async () => {
    // The stored bundles really hold the polyglot; their stored scans are pre-312 (Pass).
    const up = await as.builder.post(
      "/v1/skills?scope=team",
      zipOf("hidden-elf", { "assets/logo.png": POLYGLOT }),
    );
    expect(up.status, JSON.stringify(up.json)).toBe(201);
    await asOldScan("team_skill_reviews", teamSkill);
    await h.admin.query(
      `UPDATE team_skill_reviews SET status = 'approved', reviewed_by = $2, reviewed_at = now()
        WHERE skill_id = $1 AND version = 2`,
      [teamSkill, ids.admin],
    );
    const mine = await as.member.post(
      "/v1/skills?scope=personal",
      zipOf("my-helper", { "assets/logo.png": POLYGLOT }),
    );
    expect(mine.status, JSON.stringify(mine.json)).toBe(201);
    await asOldScan("personal_skill_scans", personalSkill);
    await h.admin.query(`DELETE FROM team_skill_reviews WHERE skill_id = $1`, [personalSkill]);

    const before = await facts(ids.member, ["hidden-elf"]);
    expect(before.agent.map((s) => s.name)).toEqual(["hidden-elf"]);
    expect(before.user.map((s) => s.name)).toEqual(["my-helper"]);

    // Two replicas at once: one rescan.
    const reports = await Promise.all([rescan("test-2"), rescan("test-2")]);
    const ran = reports.filter((r) => r?.ran);
    expect(ran).toHaveLength(1);
    const runs = await h.admin.query(
      `SELECT rule_set_version, status, scanned, suspended, failed, suspensions
         FROM skill_rescan_runs WHERE rule_set_version = 'test-2'`,
    );
    expect(runs.rows).toHaveLength(1);
    expect(runs.rows[0]).toMatchObject({ status: "done", failed: 0, suspended: 2 });
    const scanned = runs.rows[0].scanned as number;
    expect(scanned).toBeGreaterThanOrEqual(4);
    expect((await rescan("test-2"))?.ran ?? false).toBe(false);
    const again = await h.admin.query(
      `SELECT scanned FROM skill_rescan_runs WHERE rule_set_version = 'test-2'`,
    );
    expect(again.rows[0].scanned).toBe(scanned);

    const row = await h.admin.query(
      `SELECT status, suspended_at IS NOT NULL AS suspended, rule_set_version, flagged
         FROM team_skill_reviews WHERE skill_id = $1 AND version = 2`,
      [teamSkill],
    );
    expect(row.rows[0]).toEqual({
      status: "pending",
      suspended: true,
      rule_set_version: "test-2",
      flagged: true,
    });
    const after = await facts(ids.member, ["hidden-elf"]);
    expect(after.agent).toEqual([]);
    expect(after.agentSuspended).toEqual(["hidden-elf"]);
    expect(after.user).toEqual([]);
    expect(after.userSuspended).toEqual(["my-helper"]);
    expect(after.agentUnapproved).toEqual([]);

    const audit = await h.admin.query(
      `SELECT team_id, target FROM audit_log WHERE action = 'skill.rescan.suspended'
        ORDER BY seq`,
    );
    expect(audit.rows.map((r) => r.target.slug).sort()).toEqual(["hidden-elf", "my-helper"]);
    const told = h.mailer.sent.filter((m) => m.subject.includes("suspended"));
    expect(told.map((m) => m.to).sort()).toEqual(
      ["admin@rescan.test", "builder@rescan.test", "member@rescan.test"].sort(),
    );
    expect(told.every((m) => !m.text.includes("embedded-binary"))).toBe(true);
  });

  it("lets a decision lift a suspension", async () => {
    await h.admin.query(`INSERT INTO site_roles (user_id, role) VALUES ($1, 'admin')`, [ids.admin]);
    try {
      const queue = await as.admin.get("/v1/team/skill-review?status=pending");
      const row = (
        queue.json.reviews as {
          slug: string;
          version: number;
          findingsDigest: string;
          suspended: boolean;
        }[]
      ).find((r) => r.slug === "hidden-elf" && r.version === 2);
      expect(row?.suspended).toBe(true);
      const res = await as.admin.post(`/v1/team/skill-review/${teamSkill}/versions/2`, {
        decision: "rejected",
      });
      expect(res.status, JSON.stringify(res.json)).toBe(200);
      expect(res.json.review.suspended).toBe(false);
      const after = await facts(ids.member, ["hidden-elf"]);
      expect(after.agentSuspended).toEqual([]);
      // Version 1 (clean, never approved) does not come back by itself.
      expect(after.agentUnapproved).toEqual(["hidden-elf"]);
    } finally {
      await h.admin.query(`DELETE FROM site_roles WHERE user_id = $1`, [ids.admin]);
    }
  });

  it("shows each rescan in the Site console (ac-3)", async () => {
    expect((await as.admin.get("/v1/site/skill-rescans")).status).toBe(403);
    const res = await as.site.get("/v1/site/skill-rescans");
    expect(res.status, JSON.stringify(res.json)).toBe(200);
    const run = (res.json.rescans as { ruleSetVersion: string }[]).find(
      (r) => r.ruleSetVersion === "test-2",
    );
    expect(run).toMatchObject({
      status: "done",
      suspended: 2,
      failed: 0,
      suspensions: expect.arrayContaining([
        expect.objectContaining({ scope: "team", slug: "hidden-elf", teamId: finance }),
        expect.objectContaining({ scope: "personal", slug: "my-helper" }),
      ]),
    });
    expect(res.json.current).toBe(RULE_SET_VERSION);
  });
});
