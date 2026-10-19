import { readFileSync } from "node:fs";
import { strToU8, zipSync } from "fflate";
import { expect } from "vitest";
import { RawBody, type TestBrowser } from "./browser.js";
import type { Harness } from "./harness.js";

/**
 * Registry test fixtures (KOBE-333, KOBE-334): a skill package that meets SK20's rules, a team
 * version of it with the team's approval and a completed full eval, and its promotion. The eval
 * row and the team review are written directly (the runner and the team's review are tested
 * elsewhere).
 */

export const GOLDEN = JSON.parse(
  readFileSync(
    new URL(
      "../../../../packages/protocol/src/skill-evals/fixtures/scorecard/valid-full.json",
      import.meta.url,
    ),
    "utf8",
  ),
) as Record<string, unknown>;

export const CASES = readFileSync(
  new URL(
    "../../../../packages/protocol/src/skill-evals/fixtures/cases/valid-full.yaml",
    import.meta.url,
  ),
  "utf8",
);

export interface PackageOptions {
  /** Extra text in SKILL.md, so two versions differ. */
  readonly body?: string;
  readonly egress?: readonly string[];
}

export const skillMd = (name: string, body = "Add a totals row.") =>
  `---\nname: ${name}\ndescription: Builds ${name} reports. Use when asked for a ${name} report.\n---\n# ${name}\n${body}\n`;

export const manifest = (name: string, semver: string, egress: readonly string[] = []) =>
  [
    "apiVersion: kobe.dev/skill/v1",
    `name: ${name}`,
    `version: ${semver}`,
    "summary: Builds reports.",
    "license: Apache-2.0",
    `changelog: Version ${semver}.`,
    ...(egress.length > 0
      ? ["capabilities:", "  egress:", ...egress.map((h) => `    - ${h}`)]
      : []),
  ].join("\n") + "\n";

export const pkg = (name: string, semver: string, options: PackageOptions = {}) =>
  new RawBody(
    zipSync({
      "SKILL.md": strToU8(skillMd(name, options.body)),
      "kobe.skill.yaml": strToU8(manifest(name, semver, options.egress)),
      "evals/cases.yaml": strToU8(CASES),
      "evals/fixtures/sales.csv": strToU8("region,total\nnorth,1\n"),
      "evals/fixtures/regions/map.json": strToU8("{}"),
    }),
    "application/zip",
  );

/**
 * Uploads `name` at `semver` as a team version (a new skill, or the next version of the team's
 * skill of that name), approves it in the team's review and records a completed full eval of its
 * package.
 */
export async function readyTeamVersion(
  h: Harness,
  who: TestBrowser,
  teamId: string,
  reviewerId: string,
  name: string,
  semver: string,
  options: PackageOptions = {},
): Promise<{ skillId: string; version: number }> {
  const res = await who.request("POST", "/v1/skills?scope=team", pkg(name, semver, options));
  expect(res.status, JSON.stringify(res.json)).toBe(201);
  const made = res.json as { skill: { id: string }; version: { version: number } };
  const skillId = made.skill.id;
  const version = made.version.version;
  const hash = (
    await h.admin.query<{ package_hash: string }>(
      `SELECT package_hash FROM team_skill_versions WHERE skill_id = $1 AND version = $2`,
      [skillId, version],
    )
  ).rows[0]?.package_hash;
  await h.admin.query(
    `INSERT INTO skill_eval_runs (team_id, started_by, subject_kind, subject_id, subject_rev,
       skill_name, package_hash, runtime_hash, bundle_key, bundle_size, mode, status, suite, limits,
       progress_total, progress_done, scorecard, finished_at)
     VALUES ($1, $2, 'team', $3, $4, 'x', $5, repeat('b', 64), 'k', 1, 'full', 'completed', '{}',
       '{}', 5, 5, $6, now())`,
    [teamId, reviewerId, skillId, version, hash, JSON.stringify({ ...GOLDEN, packageHash: hash })],
  );
  await h.admin.query(
    `UPDATE team_skill_reviews SET status = 'approved', reviewed_by = $3, reviewed_at = now()
      WHERE team_id = $1 AND skill_id = $2 AND version = $4`,
    [teamId, skillId, reviewerId, version],
  );
  return { skillId, version };
}

/** Promotes a ready team version; the Registry version id (or the failed response). */
export async function promoteTeamVersion(
  who: TestBrowser,
  skillId: string,
  version: number,
): Promise<string> {
  const res = await who.post("/v1/skills/promotions", { scope: "team", skillId, version });
  expect(res.status, JSON.stringify(res.json)).toBe(201);
  return res.json.registryVersionId as string;
}

/** Stands in for KOBE-335's re-run: the version's authoritative scorecard, of its own package. */
export async function authoritative(h: Harness, registryVersionId: string): Promise<void> {
  await h.admin.query(
    `UPDATE registry_versions
        SET authoritative_scorecard = jsonb_set($2::jsonb, '{packageHash}', to_jsonb(package_hash))
      WHERE id = $1`,
    [registryVersionId, JSON.stringify(GOLDEN)],
  );
}
