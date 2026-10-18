import { randomBytes, randomUUID } from "node:crypto";
import { rmSync } from "node:fs";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { agentSkills, type AgentFrontmatter } from "@kobe/agent-file";
import { createDb, runMigrations, withTeam, type KobeDatabase } from "@kobe/db";
import {
  createTestDatabase,
  migrationsBefore,
  testServerUrl,
  type TestDatabase,
} from "@kobe/db/testing";
import { resolveEffective } from "./resolver/resolve.js";
import { buildResolveInput, loadSkillFacts, loadTeamFacts } from "./runs/resolver-input.js";
import { skillManifestSchema, type FrozenSkill, type SkillManifest } from "./skills/frozen.js";
import { catalogSeed, hashOf } from "./testing/catalog-seed.js";

/**
 * KOBE-318 ac-1 (SK28 migration): a site with published team agents upgrades as the non-superuser
 * owner, and every existing version resolves its skills exactly as before: same skills, same
 * versions and hashes, same notices, in the same order. Before the upgrade each version resolves
 * unfrozen (today's run start); after it, through the manifest the backfill froze. The world
 * covers every kind of named skill: newest approved, suspended newest, never approved, rejected,
 * archived, archived with its name installed from the catalog, catalog installed and not,
 * blocklisted, Required, Kobe's name, a personal skill of a named name, and another team.
 */
const MARKER = 'ALTER TABLE "team_agent_versions" ADD COLUMN "skill_manifest" jsonb';

let tdb: TestDatabase | undefined;
let app: KobeDatabase | undefined;
let adminClient: pg.Client | undefined;
let oldMigrations = "";
const must = <T>(v: T | undefined | null, what: string): T => {
  if (v === undefined || v === null) throw new Error(`${what} missing`);
  return v;
};
const admin = () => must(adminClient, "admin client");
const seed = catalogSeed(admin);
const suffix = randomBytes(4).toString("hex");
const ids = {
  user: randomUUID(),
  reviewer: randomUUID(),
  teamA: randomUUID(),
  teamB: randomUUID(),
};

type Review = "approved" | "pending" | "suspended" | "rejected";

async function teamSkill(
  team: string,
  slug: string,
  reviews: readonly Review[],
  opts: { archived?: boolean; access?: string } = {},
) {
  const id = await seed.teamSkill(team, ids.user, slug, opts.access ?? "available");
  for (const [i, review] of reviews.entries()) {
    const n = i + 1;
    await seed.addVersion(team, ids.user, id, slug, n);
    if (review !== "approved")
      await admin().query(
        `UPDATE team_skill_reviews SET status = $4::skill_review_status,
           reviewed_by = CASE WHEN $5::boolean THEN reviewed_by END,
           reviewed_at = CASE WHEN $5::boolean THEN reviewed_at END,
           suspended_at = CASE WHEN $6::boolean THEN now() END
         WHERE team_id = $1 AND skill_id = $2 AND version = $3`,
        [
          team,
          id,
          n,
          review === "suspended" ? "pending" : review,
          review === "rejected",
          review === "suspended",
        ],
      );
  }
  if (opts.archived)
    await admin().query(
      `UPDATE team_skills SET archived_at = now() WHERE team_id = $1 AND id = $2`,
      [team, id],
    );
  return id;
}

const AGENTS: { team: string; id: string; versions: AgentFrontmatter["skills"][] }[] = [];

async function agent(team: string, versions: AgentFrontmatter["skills"][]) {
  const id = randomUUID();
  await admin().query(
    `INSERT INTO team_agents (team_id, id, owner_user_id, slug, frontmatter)
     VALUES ($1, $2, $3, $4, '{"name": "A"}')`,
    [team, id, ids.user, `agent-${AGENTS.length}`],
  );
  for (const [i, skills] of versions.entries())
    await admin().query(
      `INSERT INTO team_agent_versions (team_id, agent_id, version, frontmatter, prompt,
         tool_manifest, published_by, draft_revision)
       VALUES ($1, $2, $3, $4, 'p', '{"format": 1}', $5, $3)`,
      [team, id, i + 1, JSON.stringify({ name: "A", ...(skills ? { skills } : {}) }), ids.user],
    );
  AGENTS.push({ team, id, versions });
}

async function seedWorld() {
  for (const [id, name] of [
    [ids.user, "u"],
    [ids.reviewer, "r"],
  ] as const)
    await admin().query(`INSERT INTO users (id, name, email) VALUES ($1, $2, $3)`, [
      id,
      name,
      `${name}-${suffix}@example.test`,
    ]);
  for (const team of [ids.teamA, ids.teamB]) {
    await admin().query(`INSERT INTO teams (id, slug, name) VALUES ($1, $2, 'Parity')`, [
      team,
      `parity-${team.slice(0, 8)}`,
    ]);
    await admin().query(
      `INSERT INTO team_members (team_id, user_id, role) VALUES ($1, $2, 'team_admin')`,
      [team, ids.user],
    );
  }
  const a = ids.teamA;
  await teamSkill(a, "style", ["approved", "approved", "pending"]);
  await teamSkill(a, "sus", ["approved", "suspended"]);
  await teamSkill(a, "draft", ["pending"]);
  await teamSkill(a, "gone", ["approved", "rejected"]);
  await teamSkill(a, "kept", ["approved"], { archived: true });
  await teamSkill(a, "handed", ["approved"], { archived: true });
  await teamSkill(a, "blk", ["approved"]);
  await teamSkill(a, "req", ["approved", "approved"], { access: "required" });
  await teamSkill(a, "offered", ["approved"], { access: "default_on" });
  await teamSkill(a, "pdf", ["approved"]);
  await admin().query(
    `INSERT INTO skill_blocklist (content_hash, reason, added_by) VALUES ($1, 'malware', $2)`,
    [hashOf(`${a}:blk:1`), ids.user],
  );
  const handed = await seed.catalogSkill("handed", ids.user, ids.reviewer, [["1.0.0", "approved"]]);
  await seed.install(a, ids.user, handed, "1.0.0", "pinned", "available");
  const cat = await seed.catalogSkill(`cat-${suffix}`, ids.user, ids.reviewer, [
    ["1.0.0", "approved"],
    ["1.1.0", "approved"],
  ]);
  await seed.install(a, ids.user, cat, "1.0.0", "within_major", "available");
  await seed.catalogSkill(`notinst-${suffix}`, ids.user, ids.reviewer, [["1.0.0", "approved"]]);
  await seed.personalSkill(ids.user, "style");
  await seed.personalSkill(ids.user, "mine");
  await teamSkill(ids.teamB, "other", ["approved"]);

  const all = [
    "style",
    "sus",
    "draft",
    "gone",
    "kept",
    "handed",
    "blk",
    "req",
    "pdf",
    `cat-${suffix}`,
    `notinst-${suffix}`,
    "nosuch",
    "style",
  ];
  await agent(a, [all, { exclusive: ["kept", "style", `cat-${suffix}`] }, undefined]);
  await agent(a, [["sus", "style"], { exclusive: [] }, ["offered", "mine"]]);
  // Teams are walls: team B's agent never sees team A's `style`.
  await agent(ids.teamB, [["style", "other"]]);
}

/** One version's run-start skill resolution: skills with semver, hash and source, then notices. */
async function resolution(
  team: string,
  skills: AgentFrontmatter["skills"],
  frozen: readonly FrozenSkill[] | undefined,
) {
  const db = must(app, "app db").db;
  const frontmatter = { name: "A", ...(skills ? { skills } : {}) } as AgentFrontmatter;
  return withTeam(db, team, async (tx) => {
    const facts = await loadTeamFacts(tx, team);
    const loaded = await loadSkillFacts(tx, {
      teamId: team,
      userId: ids.user,
      agentSkillNames: agentSkills(frontmatter).names,
      personalSkillsDisabled: facts.personalSkillsDisabled,
      ...(frozen ? { frozen } : {}),
    });
    const r = resolveEffective(
      buildResolveInput({
        frontmatter,
        versionMode: "ask-on-write",
        floor: "auto",
        team: facts,
        skills: loaded,
        connectedConnectors: [],
      }),
    );
    if (!r.ok) throw new Error(r.error.code);
    return {
      skills: r.value.skills.map((s) => `${s.name}@${s.semver ?? ""}:${s.source ?? ""}:${s.hash}`),
      omissions: r.value.omissions
        .filter((o) => o.kind === "skill")
        .map((o) => `${o.name}:${o.reason}`),
    };
  });
}

/** The stored manifest, read the way the server reads it (validated, fail closed). */
async function manifestOf(team: string, agentId: string, version: number): Promise<SkillManifest> {
  const { rows } = await admin().query<{ skill_manifest: unknown }>(
    `SELECT skill_manifest FROM team_agent_versions WHERE team_id = $1 AND agent_id = $2
       AND version = $3`,
    [team, agentId, version],
  );
  return skillManifestSchema.parse(must(rows[0], "version").skill_manifest);
}

const before = new Map<string, Awaited<ReturnType<typeof resolution>>>();

beforeAll(async () => {
  oldMigrations = migrationsBefore(MARKER);
  tdb = await createTestDatabase(testServerUrl(), { migrationsFolder: oldMigrations });
  adminClient = new pg.Client({ connectionString: tdb.adminUrl });
  await adminClient.connect();
  app = createDb(tdb.appUrl, { max: 2 });
  await seedWorld();
  for (const a of AGENTS)
    for (const [i, skills] of a.versions.entries())
      before.set(`${a.id}:${i + 1}`, await resolution(a.team, skills, undefined));
  // As the chart's migration Job: the non-superuser owner, on a site with rows.
  await runMigrations({ databaseUrl: tdb.ownerUrl, appRole: tdb.appRole });
}, 240_000);

afterAll(async () => {
  await app?.close();
  await adminClient?.end();
  await tdb?.drop();
  if (oldMigrations) rmSync(oldMigrations, { recursive: true, force: true });
});

describe("the SK28 backfill keeps every agent version's resolution (ac-1)", () => {
  it("resolves every version the same before and after, through its frozen manifest", async () => {
    let compared = 0;
    for (const a of AGENTS)
      for (const [i, skills] of a.versions.entries()) {
        const manifest = await manifestOf(a.team, a.id, i + 1);
        const after = await resolution(a.team, skills, manifest.skills);
        expect(after, `${a.id} v${i + 1}`).toEqual(before.get(`${a.id}:${i + 1}`));
        compared++;
      }
    expect(compared).toBe(7);
  });

  it("the world exercises loads and every kind of notice", () => {
    const first = must(before.get(`${must(AGENTS[0], "agent").id}:1`), "first");
    expect(first.skills.map((s) => s.split(":")[0])).toEqual(
      expect.arrayContaining([
        "req@0.2.0",
        "style@0.2.0",
        // Version 2 was rejected: version 1 is the newest approved one.
        "gone@0.1.0",
        "kept@0.1.0",
        "handed@1.0.0",
        `cat-${suffix}@1.1.0`,
        "offered@0.1.0",
        "mine@0.1.0",
      ]),
    );
    expect(first.omissions).toEqual(
      expect.arrayContaining([
        "sus:suspended",
        "draft:not_approved",
        "pdf:not_approved",
        "blk:blocklisted",
        "nosuch:not_approved",
        `notinst-${suffix}:not_installed`,
        "style:shadowed_by_agent",
      ]),
    );
  });

  it("freezes only the team's own named skills, in the agent's order", async () => {
    const first = must(AGENTS[0], "agent");
    const v1 = await manifestOf(first.team, first.id, 1);
    expect(v1.skills.map((s) => `${s.name}@${s.version}`)).toEqual([
      "style@2",
      "sus@2",
      "gone@1",
      "kept@1",
      "blk@1",
      "req@2",
    ]);
    const b = must(AGENTS[2], "team B agent");
    const vb = await manifestOf(b.team, b.id, 1);
    expect(vb.skills.map((s) => s.name)).toEqual(["other"]);
  });
});
