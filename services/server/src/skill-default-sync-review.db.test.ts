import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { logger } from "./logger.js";
import { listDefaultSyncs } from "./skills/catalog-admin.js";
import { defaultSyncOnce } from "./skills/default-sync.js";
import { openHarness, type Harness } from "./testing/harness.js";

/**
 * KOBE-315 review (coordinator decisions, N-314a, N-314b): the Default sync skips a team that has
 * its own skill of the same name and says so in that team's audit; a running job shows progress
 * but no counts; an `add` that backed off installs the Default's current major, not the one it
 * was queued with.
 */
let h: Harness;
let site = "";
let reviewer = "";
let defaultTag = "";

const sync = () =>
  defaultSyncOnce({ database: h.deps.database, log: logger, mailer: h.mailer, publicUrl: "" });

async function newTeam(): Promise<string> {
  const id = randomUUID();
  await h.admin.query(`INSERT INTO teams (id, slug, name) VALUES ($1, $2, 'T')`, [
    id,
    `t-${id.slice(0, 8)}`,
  ]);
  return id;
}

/** A catalog skill tagged Default with approved versions; returns its id and version ids. */
async function defaultSkill(name: string, semvers: readonly string[]) {
  const s = await h.admin.query<{ id: string }>(
    `INSERT INTO registry_skills (name, summary) VALUES ($1, 'S.') RETURNING id`,
    [name],
  );
  const skill = s.rows[0]?.id as string;
  const ids: Record<string, string> = {};
  for (const [i, semver] of semvers.entries()) {
    const r = await h.admin.query<{ id: string }>(
      `INSERT INTO registry_versions (skill_id, semver, seq, runtime_hash, package_hash, manifest,
         provenance, source, scan, verdict, state, submitted_by, reviewed_by, approved_at)
       VALUES ($1, $2, $3, repeat($4, 64), repeat($4, 64), '{}', '{}', '{}', '{}', 'pass',
         'approved', $5, $6, now()) RETURNING id`,
      [skill, semver, i + 1, String(i + 1), site, reviewer],
    );
    ids[semver] = r.rows[0]?.id as string;
  }
  await h.admin.query(
    `INSERT INTO registry_skill_tags (skill_id, tag_id, added_by) VALUES ($1, $2, $3)`,
    [skill, defaultTag, site],
  );
  return { skill, ids };
}

async function job(
  skill: string,
  kind: "add" | "move_major",
  major: number,
  versionId: string,
  extra = "",
) {
  await h.admin.query(
    `INSERT INTO skill_default_syncs (skill_id, kind, major, version_id, requested_by ${extra ? ", status, started_at, finished_at" : ""})
     VALUES ($1, $2, $3, $4, $5 ${extra})`,
    [skill, kind, major, versionId, site],
  );
}

const skillInstallOf = async (teamId: string, skill: string) =>
  (
    await h.admin.query(
      `SELECT v.semver FROM team_skill_installs i JOIN registry_versions v ON v.id = i.version_id
       WHERE i.team_id = $1 AND i.skill_id = $2`,
      [teamId, skill],
    )
  ).rows[0] as { semver: string } | undefined;

beforeAll(async () => {
  h = await openHarness();
  site = await h.createUser("site@review-sync.test", "admin");
  reviewer = await h.createUser("reviewer@review-sync.test", "admin");
  const t = await h.admin.query<{ id: string }>(
    `SELECT id FROM registry_tags WHERE kind = 'system' AND name = 'default'`,
  );
  defaultTag = t.rows[0]?.id as string;
});

afterAll(async () => {
  await h?.close();
});

describe("Default sync review fixes", () => {
  it("skips a team with its own skill of that name and audits name_conflict there", async () => {
    const clashing = await newTeam();
    const archived = await newTeam();
    const plain = await newTeam();
    const c = await defaultSkill("named-default", ["1.0.0"]);
    for (const [teamId, archivedAt] of [
      [clashing, null],
      [archived, new Date()],
    ] as const)
      await h.admin.query(
        `INSERT INTO team_skills (team_id, owner_user_id, slug, description, latest_version,
           archived_at) VALUES ($1, $2, 'named-default', 'd', 1, $3)`,
        [teamId, site, archivedAt],
      );
    await job(c.skill, "add", 1, c.ids["1.0.0"] as string);
    await sync();
    expect(await skillInstallOf(clashing, c.skill)).toBeUndefined();
    expect(await skillInstallOf(archived, c.skill)).toEqual({ semver: "1.0.0" });
    expect(await skillInstallOf(plain, c.skill)).toEqual({ semver: "1.0.0" });
    const audit = await h.admin.query(
      `SELECT team_id, target->>'change' AS change FROM audit_log
       WHERE action = 'skill.default.applied' AND target->>'skillId' = $1 ORDER BY seq`,
      [c.skill],
    );
    expect(audit.rows.filter((r) => r.team_id === clashing)).toEqual([
      { team_id: clashing, change: "name_conflict" },
    ]);
    const row = await h.admin.query(
      `SELECT name_conflicts FROM skill_default_syncs WHERE skill_id = $1`,
      [c.skill],
    );
    expect(row.rows).toEqual([{ name_conflicts: 1 }]);
    // One team: below the minimum count, so the breakdown stays hidden.
    const listed = (await listDefaultSyncs(h.deps.database.db)).find((s) => s.skillId === c.skill);
    expect(listed?.counts).toBeNull();
  });

  it("a running job shows progress but no counts; a finished one shows them", async () => {
    const c = await defaultSkill("progress-default", ["1.0.0"]);
    await job(c.skill, "add", 1, c.ids["1.0.0"] as string, ", 'done', now(), now()");
    await h.admin.query(
      `UPDATE skill_default_syncs SET installed = 7, teams_done = 7, teams_total = 7
       WHERE skill_id = $1`,
      [c.skill],
    );
    const done = (await listDefaultSyncs(h.deps.database.db)).find((s) => s.skillId === c.skill);
    expect(done?.counts?.installed).toBe(7);
    await h.admin.query(
      `UPDATE skill_default_syncs SET status = 'running', finished_at = NULL WHERE skill_id = $1`,
      [c.skill],
    );
    const running = (await listDefaultSyncs(h.deps.database.db)).find((s) => s.skillId === c.skill);
    expect([running?.teamsDone, running?.counts]).toEqual([7, null]);
    await h.admin.query(`DELETE FROM skill_default_syncs WHERE skill_id = $1`, [c.skill]);
  });

  it("an add that backed off installs the Default's current major", async () => {
    const teamId = await newTeam();
    const c = await defaultSkill("late-default", ["1.0.0", "2.0.0"]);
    // The add (major 1) failed and waits; a major move to 2 was queued and ran after it.
    await job(c.skill, "add", 1, c.ids["1.0.0"] as string);
    await h.admin.query(
      `UPDATE skill_default_syncs SET attempts = 1, next_attempt_at = now() + interval '1 hour'
       WHERE skill_id = $1`,
      [c.skill],
    );
    await job(c.skill, "move_major", 2, c.ids["2.0.0"] as string);
    await sync();
    expect(await skillInstallOf(teamId, c.skill)).toBeUndefined();
    await h.admin.query(
      `UPDATE skill_default_syncs SET next_attempt_at = now() WHERE skill_id = $1 AND kind = 'add'`,
      [c.skill],
    );
    await sync();
    expect(await skillInstallOf(teamId, c.skill)).toEqual({ semver: "2.0.0" });
  });
});
