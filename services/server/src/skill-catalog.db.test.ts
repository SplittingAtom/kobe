import { randomUUID } from "node:crypto";
import { strToU8, zipSync } from "fflate";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { scorecardForProvenance, skillEvalScorecardSchema } from "@kobe/protocol";
import { validateZipBundle } from "./skills/bundle.js";
import { forgetInstallCounts } from "./skills/catalog-browse.js";
import { ensureObject } from "./skills/kobe-seed.js";
import { sha256Hex } from "./skills/storage.js";
import type { TestBrowser } from "./testing/browser.js";
import { openHarness, type Harness } from "./testing/harness.js";
import { MemoryObjects } from "./testing/memory-objects.js";
import { GOLDEN } from "./testing/registry-fixtures.js";

/**
 * KOBE-336 (SK25, SK26, D28): the Catalog tab. Search and tag filters on a seeded catalog, sorts,
 * this team's state on each card (installed, added by me, blocked), and the detail: rendered
 * SKILL.md, files, versions and changelogs, the authoritative scorecard (numbers only), license,
 * maintainers, this team's agents, and the egress check whose Request access reaches the Team
 * admin. Nothing reviewers-only (source, provenance, submitter) reaches browsers.
 */
const team = randomUUID();
const other = randomUUID();
const objects = new MemoryObjects();
const blobs = { objects, prefix: "kobe/" };
let h: Harness;
const ids = { admin: "", member: "", maintainer: "", reviewer: "" };
type Who = keyof typeof ids;
const as = {} as Record<Who, TestBrowser>;
const email = (who: Who) => `${who}@catalog.test`;
const skills: Record<string, string> = {};

async function tag(name: string): Promise<string> {
  const r = await h.admin.query<{ id: string }>(
    `INSERT INTO registry_tags (name, kind) VALUES ($1, 'topic')
     ON CONFLICT (name) DO UPDATE SET name = excluded.name RETURNING id`,
    [name],
  );
  return r.rows[0]?.id as string;
}

/** A maintainer-published catalog skill with approved versions, its bytes in the catalog store. */
async function publish(
  name: string,
  summary: string,
  options: { tags?: string[]; egress?: string[]; versions?: string[]; rerun?: boolean } = {},
): Promise<string> {
  const skill = await h.admin.query<{ id: string }>(
    `INSERT INTO registry_skills (name, summary) VALUES ($1, $2) RETURNING id`,
    [name, summary],
  );
  const skillId = skill.rows[0]?.id as string;
  for (const t of options.tags ?? [])
    await h.admin.query(
      `INSERT INTO registry_skill_tags (skill_id, tag_id, added_by) VALUES ($1, $2, $3)`,
      [skillId, await tag(t), ids.admin],
    );
  const versions = options.versions ?? ["1.0.0"];
  for (const [i, semver] of versions.entries()) {
    const manifest = [
      "apiVersion: kobe.dev/skill/v1",
      `name: ${name}`,
      `version: ${semver}`,
      `summary: ${summary}`,
      "license: Apache-2.0",
      `changelog: Changes in ${semver}.`,
      ...((options.egress ?? []).length > 0
        ? ["capabilities:", "  egress:", ...(options.egress ?? []).map((e) => `    - ${e}`)]
        : []),
    ].join("\n");
    const valid = validateZipBundle(
      zipSync({
        "SKILL.md": strToU8(
          `---\nname: ${name}\ndescription: ${summary} Use it for ${name}.\n---\n# ${name}\n\nStep ${semver}.\n`,
        ),
        "kobe.skill.yaml": strToU8(`${manifest}\n`),
        "scripts/run.py": strToU8("print('hi')\n"),
      }),
    );
    if (!valid.ok) throw new Error(valid.error.message);
    const b = valid.value;
    const runtimeHash = sha256Hex(b.zip);
    const runtimeKey = await ensureObject(blobs, b.zip, runtimeHash);
    const packageKey = b.packageZip ? await ensureObject(blobs, b.packageZip, b.packageHash) : null;
    const card =
      options.rerun && i === versions.length - 1
        ? JSON.stringify({
            ...scorecardForProvenance(
              skillEvalScorecardSchema.parse({ ...GOLDEN, packageHash: b.packageHash }),
              new Date().toISOString(),
            ),
            rerun: { teamId: randomUUID(), evalRunId: randomUUID() },
          })
        : null;
    await h.admin.query(
      `INSERT INTO registry_versions (skill_id, semver, seq, runtime_hash, package_hash,
         runtime_storage_key, runtime_size_bytes, package_storage_key, manifest, provenance,
         source, scan, verdict, submitted_by, state, reviewed_by, approved_at,
         authoritative_scorecard)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, '{"submitter": "secret"}',
         '{"teamId": "secret-team"}', '{"findings": []}', 'pass', $10, 'approved', $11, now(),
         $12::jsonb)`,
      [
        skillId,
        semver,
        i + 1,
        runtimeHash,
        b.packageHash,
        runtimeKey,
        b.zip.length,
        packageKey,
        JSON.stringify(b.manifest),
        ids.maintainer,
        ids.reviewer,
        card,
      ],
    );
  }
  await h.admin.query(`INSERT INTO registry_maintainers (skill_id, user_id) VALUES ($1, $2)`, [
    skillId,
    ids.maintainer,
  ]);
  skills[name] = skillId;
  return skillId;
}

const latestVersion = async (skillId: string) =>
  (
    await h.admin.query<{ id: string }>(
      `SELECT id FROM registry_versions WHERE skill_id = $1 AND state = 'approved'
        ORDER BY seq DESC LIMIT 1`,
      [skillId],
    )
  ).rows[0]?.id as string;

beforeAll(async () => {
  h = await openHarness({ blobs });
  for (const who of Object.keys(ids) as Who[]) ids[who] = await h.createUser(email(who));
  await h.admin.query(
    `INSERT INTO teams (id, slug, name) VALUES ($1, 'cat', 'Cat'), ($2, 'oth', 'Oth')`,
    [team, other],
  );
  await h.admin.query(
    `INSERT INTO team_members (team_id, user_id, role) VALUES ($1, $2, 'team_admin'),
       ($1, $3, 'member'), ($4, $2, 'team_admin')`,
    [team, ids.admin, ids.member, other],
  );
  for (const who of ["admin", "member"] as Who[]) {
    as[who] = await h.signIn(email(who));
    expect((await as[who].put("/v1/me/teams/active", { teamId: team })).status).toBe(200);
    as[who].team = team;
  }
  await publish("sales-report", "Builds quarterly sales reports.", {
    tags: ["finance"],
    egress: [
      "pypi.org",
      "example.com",
      "not-allowed.test",
      "files.pythonhosted.org",
      "cdn.wild.test",
    ],
    versions: ["1.0.0", "1.1.0"],
    rerun: true,
  });
  await publish("budget-planner", "Plans the yearly budget.", {
    tags: ["finance"],
    versions: ["0.9.0", "1.0.0"],
  });
  await publish("slide-maker", "Makes presentation slides.", { tags: ["design"] });
  await publish("hidden-skill", "Never approved.", { versions: [] });
  await publish("suspended-skill", "Its only version is suspended.", { tags: ["finance"] });
  await publish("archived-skill", "Archived.", { tags: ["finance"] });
  await h.admin.query(`UPDATE registry_versions SET suspended_at = now() WHERE skill_id = $1`, [
    skills["suspended-skill"],
  ]);
  await h.admin.query(`UPDATE registry_skills SET status = 'archived' WHERE id = $1`, [
    skills["archived-skill"],
  ]);
  // Hidden states beside published ones (review-336 L6): later submitted, rejected and
  // retracted versions of sales-report, and a withdrawn 0.9.0 of budget-planner.
  for (const [semver, seq, state] of [
    ["1.2.0", 3, "submitted"],
    ["1.3.0", 4, "rejected"],
    ["1.4.0", 5, "retracted"],
  ] as const)
    await h.admin.query(
      `INSERT INTO registry_versions (skill_id, semver, seq, runtime_hash, package_hash, manifest,
         provenance, source, scan, verdict, submitted_by, state, reviewed_by)
       VALUES ($1, $2, $3, repeat('c', 64), repeat('c', 64), '{}', '{}', '{}', '{}', 'pass', $4,
         $5::registry_version_state, CASE WHEN $5 = 'rejected' THEN $6::uuid END)`,
      [skills["sales-report"], semver, seq, ids.maintainer, state, ids.reviewer],
    );
  await h.admin.query(
    `UPDATE registry_versions SET state = 'withdrawn' WHERE skill_id = $1 AND semver = '0.9.0'`,
    [skills["budget-planner"]],
  );
  // A retired topic tag can't be probed through the filter (L4).
  await h.admin.query(
    `INSERT INTO registry_tags (name, kind, status) VALUES ('old-topic', 'topic', 'retired')`,
  );
  await h.admin.query(
    `INSERT INTO registry_skill_tags (skill_id, tag_id, added_by)
     SELECT $1, id, $2 FROM registry_tags WHERE name = 'old-topic'`,
    [skills["slide-maker"], ids.admin],
  );
  await h.admin.query(
    `INSERT INTO egress_domains (domain, in_ceiling) VALUES ('pypi.org', true), ('example.com', true),
       ('*.pythonhosted.org', true), ('*.wild.test', true)
     ON CONFLICT (domain) DO UPDATE SET in_ceiling = true`,
  );
  await h.admin.query(
    `INSERT INTO team_egress (team_id, domain, enabled_by) VALUES ($1, 'pypi.org', $2),
       ($1, '*.pythonhosted.org', $2)`,
    [team, ids.admin],
  );
  // This team installed sales-report, blocked slide-maker; the member added budget-planner.
  await h.admin.query(
    `INSERT INTO team_skill_installs (team_id, skill_id, version_id, pin_mode, access, installed_by)
     VALUES ($1, $2, $3, 'pinned', 'available', $4)`,
    [
      team,
      skills["sales-report"],
      await latestVersion(skills["sales-report"] as string),
      ids.admin,
    ],
  );
  await h.admin.query(
    `INSERT INTO team_skill_blocks (team_id, skill_id, blocked_by) VALUES ($1, $2, $3)`,
    [team, skills["slide-maker"], ids.admin],
  );
  await h.admin.query(
    `INSERT INTO member_skill_enablements (team_id, user_id, catalog_skill_id, enabled, version_id,
       pin_mode) VALUES ($1, $2, $3, true, $4, 'pinned')`,
    [
      team,
      ids.member,
      skills["budget-planner"],
      await latestVersion(skills["budget-planner"] as string),
    ],
  );
  // An agent of the team names sales-report.
  const agent = randomUUID();
  await h.admin.query(
    `INSERT INTO team_agents (team_id, id, slug, frontmatter, owner_user_id)
     VALUES ($1, $2, 'reporter', '{"name": "Reporter", "skills": ["sales-report"]}', $3)`,
    [team, agent, ids.admin],
  );
  await h.admin.query(
    `INSERT INTO team_agent_versions (team_id, agent_id, version, frontmatter, prompt,
       tool_manifest, published_by, skill_manifest, draft_revision)
     VALUES ($1, $2, 1, '{"name": "Reporter", "skills": ["sales-report"]}', 'p', '{}', $3,
       '{"skills": []}', 1)`,
    [team, agent, ids.admin],
  );
  await h.admin.query(`UPDATE team_agents SET current_version = 1 WHERE team_id = $1 AND id = $2`, [
    team,
    agent,
  ]);
  forgetInstallCounts();
});

afterAll(async () => {
  await h?.close();
});

const names = (json: Record<string, unknown>) =>
  (json.skills as { name: string }[]).map((s) => s.name);

describe("browse and search (ac-1)", () => {
  it("lists approved skills only, searches and filters by tag", async () => {
    const all = await as.member.get("/v1/skills/catalog");
    expect(all.status, JSON.stringify(all.json)).toBe(200);
    expect(names(all.json)).toEqual(["budget-planner", "sales-report", "slide-maker"]);
    expect(all.json.tags).toEqual(["design", "finance"]);
    expect(names((await as.member.get("/v1/skills/catalog?q=quarterly")).json)).toEqual([
      "sales-report",
    ]);
    expect(names((await as.member.get("/v1/skills/catalog?q=presentations")).json)).toEqual([
      "slide-maker",
    ]);
    expect(names((await as.member.get("/v1/skills/catalog?q=budget")).json)).toEqual([
      "budget-planner",
    ]);
    expect(names((await as.member.get("/v1/skills/catalog?tag=finance")).json)).toEqual([
      "budget-planner",
      "sales-report",
    ]);
    expect(names((await as.member.get("/v1/skills/catalog?tag=finance&q=sales")).json)).toEqual([
      "sales-report",
    ]);
    expect((await as.member.get("/v1/skills/catalog?sort=nope")).status).toBe(400);
    expect(names((await as.member.get("/v1/skills/catalog?tag=old-topic")).json)).toEqual([]);
  });

  it("shows this team's state, the latest version and the minimum-count rule", async () => {
    const all = await as.member.get("/v1/skills/catalog?sort=teams");
    const card = (n: string) =>
      (all.json.skills as Record<string, unknown>[]).find((s) => s.name === n);
    expect(names(all.json)[0]).toBe("sales-report");
    expect(card("sales-report")).toMatchObject({
      latest: { semver: "1.1.0", verdict: "pass" },
      score: { passRate: expect.any(Number), cases: expect.any(Number) },
      teamsInstalled: "few",
      state: {
        installed: { semver: "1.1.0", pinMode: "pinned" },
        addedByMe: false,
        blocked: false,
      },
      topics: ["finance"],
    });
    expect(card("budget-planner")).toMatchObject({
      state: { installed: null, addedByMe: true },
      teamsInstalled: 0,
    });
    expect(card("slide-maker")).toMatchObject({ state: { blocked: true } });
    // Never a reviewer's fields.
    expect(JSON.stringify(all.json)).not.toContain("secret");
  });
});

describe("detail (ac-2, ac-3)", () => {
  it("shows SKILL.md, files, versions, changelogs, the authoritative card and the egress check", async () => {
    const d = await as.member.get(`/v1/skills/catalog/${skills["sales-report"]}`);
    expect(d.status, JSON.stringify(d.json)).toBe(200);
    expect(d.json.skillMd).toBe("# sales-report\n\nStep 1.1.0.\n");
    expect((d.json.files as { path: string }[]).map((f) => f.path)).toEqual([
      "SKILL.md",
      "kobe.skill.yaml",
      "scripts/run.py",
    ]);
    // Submitted, rejected and retracted versions never show; the card is the approved 1.1.0.
    expect(d.json.latest).toMatchObject({ semver: "1.1.0" });
    expect(
      (d.json.versions as { semver: string; changelog: string }[]).map((v) => [
        v.semver,
        v.changelog,
      ]),
    ).toEqual([
      ["1.1.0", "Changes in 1.1.0."],
      ["1.0.0", "Changes in 1.0.0."],
    ]);
    const budget = await as.member.get(`/v1/skills/catalog/${skills["budget-planner"]}`);
    expect(
      (budget.json.versions as { semver: string; state: string }[]).map((v) => [v.semver, v.state]),
    ).toEqual([
      ["1.0.0", "approved"],
      ["0.9.0", "withdrawn"],
    ]);
    for (const hidden of ["suspended-skill", "archived-skill"])
      expect((await as.member.get(`/v1/skills/catalog/${skills[hidden]}`)).status, hidden).toBe(
        404,
      );
    // The catalog card's own fields only (an allowlist): never the re-run's facts.
    expect(d.json.authoritativeScorecard).toMatchObject({
      packageHash: expect.any(String),
      mode: "full",
      cases: expect.any(Number),
      passRateWith: expect.any(Number),
    });
    expect(d.json.authoritativeScorecard).not.toHaveProperty("rerun");
    expect(d.json).toMatchObject({
      license: "Apache-2.0",
      maintainers: ["maintainer"],
      agents: [{ name: "Reporter" }],
      egress: [
        { host: "pypi.org", enabledHere: true, inCeiling: true },
        { host: "example.com", enabledHere: false, inCeiling: true },
        { host: "not-allowed.test", enabledHere: false, inCeiling: false },
        // Wildcard patterns, matched as the egress proxy matches them (review-336 M2).
        { host: "files.pythonhosted.org", enabledHere: true, inCeiling: true },
        { host: "cdn.wild.test", enabledHere: false, inCeiling: true },
      ],
      canRequestEgress: true,
    });
    expect(JSON.stringify(d.json)).not.toContain("secret");
    expect(JSON.stringify(d.json)).not.toContain("@catalog.test");
    expect((await as.member.get(`/v1/skills/catalog/${skills["hidden-skill"]}`)).status).toBe(404);

    // Request access for a host not enabled here reaches the Team admin (D28).
    const asked = await as.member.post("/v1/egress/requests", { domain: "example.com" });
    expect(asked.status, JSON.stringify(asked.json)).toBe(201);
    await h.mailer.settle();
    expect(h.mailer.to(email("admin")).some((m) => m.text.includes("example.com"))).toBe(true);
  });
});
