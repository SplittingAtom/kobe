import { randomBytes, randomUUID } from "node:crypto";
import { rmSync } from "node:fs";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runMigrations } from "./migrate.js";
import {
  createTestDatabase,
  migrationsBefore,
  testServerUrl,
  type TestDatabase,
} from "./test-support/database.js";

/**
 * KOBE-318 (SK28): a site with published team agents migrates as the non-superuser owner (as the
 * chart's Job does). Every existing team agent version is frozen at the local skill versions it
 * resolves to on migration day: per named team skill, its newest approved or suspended version
 * (`teamSkillStates`), never a catalog-routed name (Kobe's seven, or an archived skill whose
 * name the team installed), never another team's skill. FORCE RLS and the immutability trigger
 * are back afterwards, and from then on every version needs a manifest.
 */

const MARKER = 'ALTER TABLE "team_agent_versions" ADD COLUMN "skill_manifest" jsonb';
const HASH = (s: string) => Buffer.from(s.padEnd(32, "-")).toString("hex").slice(0, 64);

let db: TestDatabase | undefined;
let oldMigrations = "";
const database = (): TestDatabase => {
  if (!db) throw new Error("database not created");
  return db;
};
const suffix = randomBytes(4).toString("hex");
const ids = {
  user: randomUUID(),
  reviewer: randomUUID(),
  teamA: randomUUID(),
  teamB: randomUUID(),
  agentA: randomUUID(),
  agentB: randomUUID(),
  catalogOld: randomUUID(),
  catalogVersion: randomUUID(),
  skills: {} as Record<string, string>,
};

async function withClient<T>(url: string, fn: (c: pg.Client) => Promise<T>): Promise<T> {
  const c = new pg.Client({ connectionString: url });
  await c.connect();
  try {
    return await fn(c);
  } finally {
    await c.end();
  }
}

type Review = "approved" | "pending" | "suspended" | "rejected";

/** A team skill with versions 1..n in the given review states (rows as the routes write them). */
async function teamSkill(
  c: pg.Client,
  team: string,
  slug: string,
  reviews: readonly Review[],
  archived = false,
): Promise<string> {
  const id = randomUUID();
  ids.skills[`${team}:${slug}`] = id;
  await c.query(
    `INSERT INTO team_skills (team_id, id, owner_user_id, slug, description, latest_version, archived_at)
     VALUES ($1, $2, $3, $4, 'd', $5, $6)`,
    [team, id, ids.user, slug, reviews.length, archived ? new Date() : null],
  );
  for (const [i, review] of reviews.entries()) {
    const n = i + 1;
    const hash = HASH(`${slug}${n}${team.slice(0, 4)}`);
    await c.query(
      `INSERT INTO team_skill_versions (team_id, skill_id, version, frontmatter, source, content_hash,
         storage_key, size_bytes, file_count, uncompressed_bytes, uploaded_by, semver, seq)
       VALUES ($1, $2, $3, '{}', 'zip', $4, 'k', 1, 1, 1, $5, '0.' || $3::int || '.0', $3::int)`,
      [team, id, n, hash, ids.user],
    );
    const decided = review === "approved" || review === "rejected";
    await c.query(
      `INSERT INTO team_skill_reviews (team_id, skill_id, version, scope, slug, content_hash, status,
         flagged, findings, scripts, skipped, reviewed_by, reviewed_at, suspended_at)
       VALUES ($1, $2, $3, 'team', $4, $5, $6, false, '[]', '[]', '[]', $7, $8, $9)`,
      [
        team,
        id,
        n,
        slug,
        hash,
        review === "suspended" ? "pending" : review,
        decided ? ids.user : null,
        decided ? new Date() : null,
        review === "suspended" ? new Date() : null,
      ],
    );
  }
  return id;
}

async function agentVersion(
  c: pg.Client,
  team: string,
  agent: string,
  version: number,
  skills: unknown,
): Promise<void> {
  const frontmatter = skills === undefined ? { name: "A" } : { name: "A", skills };
  await c.query(
    `INSERT INTO team_agent_versions (team_id, agent_id, version, frontmatter, prompt, tool_manifest,
       published_by, draft_revision)
     VALUES ($1, $2, $3, $4, 'p', '{"format": 1}', $5, $3)`,
    [team, agent, version, JSON.stringify(frontmatter), ids.user],
  );
}

/** Rows as the release before KOBE-318 wrote them (superuser: RLS does not get in the way). */
async function seed(c: pg.Client): Promise<void> {
  for (const [id, name] of [
    [ids.user, "u"],
    [ids.reviewer, "r"],
  ] as const)
    await c.query(`INSERT INTO users (id, name, email) VALUES ($1, $2, $3)`, [
      id,
      name,
      `${name}-${suffix}@example.test`,
    ]);
  for (const [id, slug] of [
    [ids.teamA, `freeze-a-${suffix}`],
    [ids.teamB, `freeze-b-${suffix}`],
  ] as const)
    await c.query(`INSERT INTO teams (id, slug, name) VALUES ($1, $2, 'Freeze')`, [id, slug]);
  // Team A: newest approved (v3 pending is not yet usable), a suspended newest, never approved,
  // rejected after approval, archived (kept for frozen agents), archived with the name handed to
  // an installed catalog skill, and a team `pdf` from before the upgrade (Kobe's name).
  await teamSkill(c, ids.teamA, "style", ["approved", "approved", "pending"]);
  await teamSkill(c, ids.teamA, "sus", ["approved", "suspended"]);
  await teamSkill(c, ids.teamA, "draft", ["pending"]);
  await teamSkill(c, ids.teamA, "gone", ["rejected"]);
  await teamSkill(c, ids.teamA, "kept", ["approved"], true);
  await teamSkill(c, ids.teamA, "handed", ["approved"], true);
  await teamSkill(c, ids.teamA, "pdf", ["approved"]);
  // Team B has its own `other` and no `style`.
  await teamSkill(c, ids.teamB, "other", ["approved"]);
  await c.query(`INSERT INTO registry_skills (id, name, summary) VALUES ($1, 'handed', 'H.')`, [
    ids.catalogOld,
  ]);
  await c.query(
    `INSERT INTO registry_versions (id, skill_id, semver, seq, runtime_hash, package_hash, manifest,
       provenance, source, scan, verdict, state, approved_at, submitted_by, reviewed_by)
     VALUES ($1, $2, '1.0.0', 1, $3, $3, '{}', '{}', '{}', '{}', 'pass', 'approved', now(), $4, $5)`,
    [ids.catalogVersion, ids.catalogOld, HASH("catalog-handed"), ids.user, ids.reviewer],
  );
  await c.query(
    `INSERT INTO team_skill_installs (team_id, skill_id, version_id, pin_mode, access, installed_by)
     VALUES ($1, $2, $3, 'pinned', 'available', $4)`,
    [ids.teamA, ids.catalogOld, ids.catalogVersion, ids.user],
  );
  for (const [team, agent] of [
    [ids.teamA, ids.agentA],
    [ids.teamB, ids.agentB],
  ] as const)
    await c.query(
      `INSERT INTO team_agents (team_id, id, owner_user_id, slug, frontmatter)
       VALUES ($1, $2, $3, 'agent', '{"name": "A"}')`,
      [team, agent, ids.user],
    );
  await agentVersion(c, ids.teamA, ids.agentA, 1, [
    "style",
    "sus",
    "draft",
    "gone",
    "kept",
    "handed",
    "pdf",
    "nosuch",
    "style",
  ]);
  await agentVersion(c, ids.teamA, ids.agentA, 2, { exclusive: ["kept", "style"] });
  await agentVersion(c, ids.teamA, ids.agentA, 3, undefined);
  await agentVersion(c, ids.teamA, ids.agentA, 4, { exclusive: [] });
  await agentVersion(c, ids.teamB, ids.agentB, 1, ["style", "other"]);
}

beforeAll(async () => {
  oldMigrations = migrationsBefore(MARKER);
  db = await createTestDatabase(testServerUrl(), { migrationsFolder: oldMigrations });
  await withClient(db.adminUrl, seed);
  await runMigrations({ databaseUrl: db.ownerUrl, appRole: db.appRole });
}, 180_000);

afterAll(async () => {
  await db?.drop();
  if (oldMigrations) rmSync(oldMigrations, { recursive: true, force: true });
});

const frozen = (team: string, name: string, version: number) => ({
  name,
  skill_id: ids.skills[`${team}:${name}`],
  version,
});

describe("agent skill manifest backfill (KOBE-318)", () => {
  it("freezes every team agent version at what it resolves to on migration day", async () => {
    await withClient(database().adminUrl, async (c) => {
      const { rows } = await c.query<{ team_id: string; version: number; skill_manifest: unknown }>(
        `SELECT team_id, version, skill_manifest FROM team_agent_versions
          ORDER BY team_id = $1 DESC, version`,
        [ids.teamA],
      );
      expect(rows).toEqual([
        {
          team_id: ids.teamA,
          version: 1,
          // In the agent's order, once each; `draft` and `gone` have no usable version, `handed`
          // resolves through the install, `pdf` is Kobe's and `nosuch` is nobody's.
          skill_manifest: {
            skills: [
              frozen(ids.teamA, "style", 2),
              frozen(ids.teamA, "sus", 2),
              frozen(ids.teamA, "kept", 1),
            ],
          },
        },
        {
          team_id: ids.teamA,
          version: 2,
          skill_manifest: {
            skills: [frozen(ids.teamA, "kept", 1), frozen(ids.teamA, "style", 2)],
          },
        },
        { team_id: ids.teamA, version: 3, skill_manifest: { skills: [] } },
        { team_id: ids.teamA, version: 4, skill_manifest: { skills: [] } },
        // Teams are walls: team A's `style` is never frozen for team B's agent.
        {
          team_id: ids.teamB,
          version: 1,
          skill_manifest: { skills: [frozen(ids.teamB, "other", 1)] },
        },
      ]);
    });
  });

  it("restores FORCE RLS and the immutability trigger", async () => {
    await withClient(database().adminUrl, async (c) => {
      const force = await c.query(
        `SELECT relname, relforcerowsecurity AS forced FROM pg_class
          WHERE relname IN ('team_agent_versions', 'team_skills', 'team_skill_reviews',
            'team_skill_installs')
          ORDER BY relname`,
      );
      expect(force.rows).toEqual([
        { relname: "team_agent_versions", forced: true },
        { relname: "team_skill_installs", forced: true },
        { relname: "team_skill_reviews", forced: true },
        { relname: "team_skills", forced: true },
      ]);
      const trigger = await c.query(
        `SELECT tgenabled FROM pg_trigger WHERE tgname = 'team_agent_versions_immutable'`,
      );
      expect(trigger.rows).toEqual([{ tgenabled: "O" }]);
    });
    // Under FORCE the owner sees no team rows, so the superuser tries: the trigger refuses.
    await withClient(database().adminUrl, async (c) => {
      await expect(
        c.query(`UPDATE team_agent_versions SET skill_manifest = '{"skills": []}'`),
      ).rejects.toMatchObject({ code: "55000" });
    });
  });

  it("requires a manifest object with a skills array on every new version", async () => {
    await withClient(database().adminUrl, async (c) => {
      const insert = (version: number, manifest: string | null) =>
        c.query(
          `INSERT INTO team_agent_versions (team_id, agent_id, version, frontmatter, prompt,
             tool_manifest, published_by, draft_revision, skill_manifest)
           VALUES ($1, $2, $3, '{"name": "A"}', 'p', '{"format": 1}', $4, $3, $5)`,
          [ids.teamA, ids.agentA, version, ids.user, manifest],
        );
      for (const bad of [
        null,
        "[]",
        '{"skills": {}}',
        "{}",
        `{"skills": ["${"x".repeat(17000)}"]}`,
      ])
        await expect(insert(5, bad)).rejects.toMatchObject({
          constraint: "team_agent_versions_skill_manifest",
        });
      await insert(5, JSON.stringify({ skills: [frozen(ids.teamA, "style", 1)] }));
    });
  });
});
