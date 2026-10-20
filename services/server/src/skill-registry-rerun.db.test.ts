import { randomUUID } from "node:crypto";
import { strToU8, zipSync } from "fflate";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { skillEvalScorecardSchema } from "@kobe/protocol";
import { withTeam } from "@kobe/db";
import { validateZipBundle } from "./skills/bundle.js";
import { recordAuthoritativeScorecard } from "./skills/registry/authoritative.js";
import { ensureObject } from "./skills/kobe-seed.js";
import { sha256Hex } from "./skills/storage.js";
import type { Person } from "./testing/event-stream-fixture.js";
import { SkillEvalBench, skillMd } from "./testing/skill-eval-bench.js";

/**
 * KOBE-335 (SK23, SK17, SK21): Re-run evals of a submitted Registry version runs a full eval in
 * the Registry team (its threads, runs and budget), as a member of that team, judged by the Site
 * judge only; the completed card (numbers only, with the re-run's facts) is stored as the
 * version's authoritative scorecard, shown on the review screen, and Approve opens with it.
 */
const bench = new SkillEvalBench();
const { f } = bench;
const admin = () => f.fx.admin;
let reviewer: Person;
let outsider: Person;
/** Submits every version here; a Skill reviewer, so a member of the Registry team too. */
let submitter: Person;
let registryTeam = "";
const SUITE = [
  "cases:",
  "  - id: totals",
  "    prompt: Build the report",
  "    expect: {contains: Total}",
  "  - id: judged",
  "    prompt: Summarize it",
  "    expect: {judge: A totals row is present.}",
  "  - id: unrelated",
  "    prompt: What is the capital of France?",
  "    expect: {triggers: false}",
  "",
].join("\n");

beforeAll(async () => {
  await bench.setup();
  const w = await bench.world();
  reviewer = w.owner;
  outsider = await f.fx.person("outsider");
  submitter = await f.fx.person("submitter");
  await admin().query(
    `INSERT INTO site_roles (user_id, role) VALUES ($1, 'admin'), ($2, 'admin')`,
    [reviewer.id, outsider.id],
  );
  const made = await f.on(0, reviewer).post("/v1/site/skills/registry/team", {
    name: "Registry",
    slug: `reg-${randomUUID().slice(0, 6)}`,
  });
  expect(made.status, JSON.stringify(made.json)).toBe(201);
  registryTeam = made.json.registryTeam.id as string;
  await admin().query(
    `INSERT INTO team_models (team_id, alias, is_default, enabled_by) VALUES ($1, 'fast', true, $2)`,
    [registryTeam, reviewer.id],
  );
  const grant = await f
    .on(0, reviewer)
    .request("PUT", `/v1/site/roles/grants/${submitter.id}/skill_reviewer`, {});
  expect(grant.status, JSON.stringify(grant.json)).toBe(200);
  const judge = await f
    .on(0, reviewer)
    .request("PUT", "/v1/site/skills/registry/settings", { judgeAlias: "fast" });
  expect(judge.status, JSON.stringify(judge.json)).toBe(200);
});

afterAll(async () => {
  await bench.teardown();
});

/** A submitted Registry version of `name`, its package in the catalog store. */
async function submittedVersion(name: string, submitter: string): Promise<string> {
  const manifest = `apiVersion: kobe.dev/skill/v1\nname: ${name}\nversion: 0.1.0\nsummary: Reports.\nlicense: Apache-2.0\n`;
  const valid = validateZipBundle(
    zipSync({
      "SKILL.md": strToU8(skillMd(name)),
      "kobe.skill.yaml": strToU8(manifest),
      "evals/cases.yaml": strToU8(SUITE),
    }),
  );
  if (!valid.ok) throw new Error(valid.error.message);
  const b = valid.value;
  const runtimeHash = sha256Hex(b.zip);
  const runtimeKey = await ensureObject(bench.blobs, b.zip, runtimeHash);
  const packageKey = b.packageZip
    ? await ensureObject(bench.blobs, b.packageZip, b.packageHash)
    : null;
  const skill = await admin().query<{ id: string }>(
    `INSERT INTO registry_skills (name, summary) VALUES ($1, 'Reports.') RETURNING id`,
    [name],
  );
  const v = await admin().query<{ id: string }>(
    `INSERT INTO registry_versions (skill_id, semver, seq, runtime_hash, package_hash,
       runtime_storage_key, runtime_size_bytes, package_storage_key, manifest, provenance, source,
       scan, verdict, submitted_by)
     VALUES ($1, '0.1.0', 1, $2, $3, $4, $5, $6, '{}', '{}', '{}', '{"findings": []}', 'pass', $7)
     RETURNING id`,
    [
      skill.rows[0]?.id,
      runtimeHash,
      b.packageHash,
      runtimeKey,
      b.zip.length,
      packageKey,
      submitter,
    ],
  );
  return v.rows[0]?.id as string;
}

describe("Re-run evals in the Registry team (KOBE-335)", () => {
  it("runs there with the Site judge and stores the authoritative scorecard Approve needs", async () => {
    const id = await submittedVersion("rerun-report", submitter.id);
    const before = await f.on(0, reviewer).get(`/v1/site/skills/registry/${id}`);
    expect((before.json.approveProblems as { code: string }[]).map((p) => p.code)).toContain(
      "authoritative_scorecard_missing",
    );
    const started = await f.on(0, reviewer).post(`/v1/site/skills/registry/${id}/rerun-evals`, {});
    expect(started.status, JSON.stringify(started.json)).toBe(202);
    const evalRunId = started.json.evalRunId as string;
    const run = await admin().query<{
      team_id: string;
      started_by: string;
      subject_kind: string;
      mode: string;
      judge_model: unknown;
    }>(
      `SELECT team_id, started_by, subject_kind, mode, judge_model FROM skill_eval_runs WHERE id = $1`,
      [evalRunId],
    );
    expect(run.rows[0]).toEqual({
      team_id: registryTeam,
      started_by: reviewer.id,
      subject_kind: "registry",
      mode: "full",
      judge_model: { alias: "fast", source: "site" },
    });

    const provider = bench.provider();
    await bench.drive(bench.runnerFor(provider), registryTeam, evalRunId);
    // Its executions ran as runs of the Registry team: that team's budget pays (SK21).
    const runs = await admin().query<{ team_id: string }>(
      `SELECT DISTINCT r.team_id FROM skill_eval_results x
         JOIN runs r ON r.id = (x.execution ->> 'runId')::uuid
        WHERE x.eval_run_id = $1`,
      [evalRunId],
    );
    expect(runs.rows).toEqual([{ team_id: registryTeam }]);

    const stored = await admin().query<{ card: Record<string, unknown>; package_hash: string }>(
      `SELECT authoritative_scorecard AS card, package_hash FROM registry_versions WHERE id = $1`,
      [id],
    );
    const card = stored.rows[0]?.card;
    expect(card).toMatchObject({
      packageHash: stored.rows[0]?.package_hash,
      mode: "full",
      cases: 3,
      judge: { source: "site" },
      rerun: { teamId: registryTeam, evalRunId, judgeAlias: "fast" },
    });
    // Numbers only: no case ids, prompts, threads or reasons leave the Registry team.
    const text = JSON.stringify(card);
    for (const leak of ["totals", "Build the report", "threadId", "reason"])
      expect(text).not.toContain(leak);

    const after = await f.on(0, reviewer).get(`/v1/site/skills/registry/${id}`);
    expect(after.json.authoritativeScorecard).toMatchObject({ cases: 3 });
    expect(after.json.reruns).toMatchObject([
      { evalRunId, status: "completed", current: true, startedBy: { id: reviewer.id } },
    ]);
    expect((after.json.approveProblems as { code: string }[]).map((p) => p.code)).not.toContain(
      "authoritative_scorecard_missing",
    );
    const approved = await f
      .on(0, reviewer)
      .post(`/v1/site/skills/registry/${id}/decision`, { action: "approve" });
    expect(approved.status, JSON.stringify(approved.json)).toBe(200);
    const audits = await admin().query<{ action: string }>(
      `SELECT action FROM audit_log WHERE target ->> 'registryVersionId' = $1
         AND action IN ('registry.evals_rerun', 'registry.authoritative_scorecard') ORDER BY seq`,
      [id],
    );
    expect(audits.rows.map((r) => r.action)).toEqual([
      "registry.evals_rerun",
      "registry.authoritative_scorecard",
    ]);
  });

  it("is refused outside the Registry team and without the Site judge there", async () => {
    const id = await submittedVersion("rerun-refused", submitter.id);
    // Neither the submitter (a Skill reviewer here) starts one (review-335 M3).
    const own = await f.on(0, submitter).post(`/v1/site/skills/registry/${id}/rerun-evals`, {});
    expect([own.status, own.json.code]).toEqual([403, "own_submission"]);
    const outside = await f.on(0, outsider).post(`/v1/site/skills/registry/${id}/rerun-evals`, {});
    expect([outside.status, outside.json.code]).toEqual([409, "not_registry_member"]);
    expect(outside.json.message).toMatch(/ask another Site admin for the Skill reviewer grant/);
    // Another Site admin grants it: the outsider joins the Registry team and may re-run.
    expect(
      (
        await f
          .on(0, reviewer)
          .request("PUT", `/v1/site/roles/grants/${outsider.id}/skill_reviewer`, {})
      ).status,
    ).toBe(200);
    const granted = await f.on(0, outsider).post(`/v1/site/skills/registry/${id}/rerun-evals`, {});
    expect(granted.status, JSON.stringify(granted.json)).toBe(202);
    await bench.closeEvals(registryTeam);
    await admin().query(
      `INSERT INTO model_catalog (alias, provider_id, model, created_by)
       VALUES ('judge-x', 'openai', 'judge-x', $1) ON CONFLICT (alias) DO NOTHING`,
      [reviewer.id],
    );
    await admin().query(`UPDATE site_skill_settings SET judge_alias = 'judge-x' WHERE id = 1`);
    try {
      const noJudge = await f
        .on(0, reviewer)
        .post(`/v1/site/skills/registry/${id}/rerun-evals`, {});
      expect([noJudge.status, noJudge.json.code]).toEqual([409, "site_judge_unavailable"]);
    } finally {
      await admin().query(`UPDATE site_skill_settings SET judge_alias = 'fast' WHERE id = 1`);
    }
  });

  it("goes stale when the Registry team or the Site judge changes", async () => {
    const id = await submittedVersion("rerun-stale", submitter.id);
    await admin().query(
      `UPDATE registry_versions SET authoritative_scorecard = jsonb_build_object(
         'packageHash', package_hash, 'judge', jsonb_build_object('source', 'site'),
         'rerun', jsonb_build_object('teamId', $2::text, 'evalRunId', gen_random_uuid(),
           'judgeAlias', 'old-judge'))
        WHERE id = $1`,
      [id, registryTeam],
    );
    const judged = await f.on(0, reviewer).get(`/v1/site/skills/registry/${id}`);
    expect((judged.json.approveProblems as { code: string }[]).map((p) => p.code)).toContain(
      "authoritative_scorecard_stale",
    );
    await admin().query(
      `UPDATE registry_versions SET authoritative_scorecard = jsonb_build_object(
         'packageHash', package_hash,
         'rerun', jsonb_build_object('teamId', gen_random_uuid(), 'evalRunId', gen_random_uuid()))
        WHERE id = $1`,
      [id],
    );
    const elsewhere = await f.on(0, reviewer).get(`/v1/site/skills/registry/${id}`);
    expect((elsewhere.json.approveProblems as { code: string }[]).map((p) => p.code)).toContain(
      "authoritative_scorecard_stale",
    );
  });

  it("keeps every re-run with its starter; the latest completed card counts, lower ones show", async () => {
    const id = await submittedVersion("rerun-history", submitter.id);
    const start = async () => {
      const r = await f.on(0, reviewer).post(`/v1/site/skills/registry/${id}/rerun-evals`, {});
      expect(r.status, JSON.stringify(r.json)).toBe(202);
      return r.json.evalRunId as string;
    };
    // A first run that fails its cases, then a cancelled one, then a passing one.
    const low = await start();
    const failing = bench.provider();
    failing.answer = () => "nothing useful";
    await bench.drive(bench.runnerFor(failing), registryTeam, low);
    const cancelled = await start();
    // Not through the team's own cancel route, nor by the submitter.
    const viaTeam = await f.on(0, reviewer).post(`/v1/skill-evals/${cancelled}/cancel`, {});
    expect(viaTeam.status).not.toBe(202);
    const bySubmitter = await f
      .on(0, submitter)
      .post(`/v1/site/skills/registry/${id}/reruns/${cancelled}/cancel`, {});
    expect(bySubmitter.status).toBe(403);
    const cancel = await f
      .on(0, reviewer)
      .post(`/v1/site/skills/registry/${id}/reruns/${cancelled}/cancel`, {});
    expect(cancel.status, JSON.stringify(cancel.json)).toBe(202);
    const high = await start();
    await bench.drive(bench.runnerFor(bench.provider()), registryTeam, high);

    const detail = await f.on(0, reviewer).get(`/v1/site/skills/registry/${id}`);
    expect(detail.json.authoritativeScorecard).toMatchObject({ rerun: { evalRunId: high } });
    expect(
      (detail.json.reruns as Record<string, unknown>[]).map((r) => [
        r.evalRunId,
        r.status,
        r.current,
        r.lowerThanCurrent,
        (r.startedBy as { id: string }).id,
        (r.cancelledBy as { id: string } | null)?.id ?? null,
      ]),
    ).toEqual([
      [low, "completed", false, true, reviewer.id, null],
      [cancelled, "cancelled", false, false, reviewer.id, reviewer.id],
      [high, "completed", true, false, reviewer.id, null],
    ]);
  });

  it("stops open re-runs when the version is decided (review-335 L3)", async () => {
    const id = await submittedVersion("rerun-decided", submitter.id);
    const started = await f.on(0, reviewer).post(`/v1/site/skills/registry/${id}/rerun-evals`, {});
    const evalRunId = started.json.evalRunId as string;
    const rejected = await f
      .on(0, reviewer)
      .post(`/v1/site/skills/registry/${id}/decision`, { action: "reject", note: "No." });
    expect(rejected.status, JSON.stringify(rejected.json)).toBe(200);
    const run = await admin().query(`SELECT status FROM skill_eval_runs WHERE id = $1`, [
      evalRunId,
    ]);
    expect(run.rows).toEqual([{ status: "cancelled" }]);
  });

  it("holds the Registry team's open-eval limit and binds the card to its package (review-335 L7)", async () => {
    const ids = await Promise.all(
      [1, 2, 3, 4].map((n) => submittedVersion(`rerun-limit-${n}`, submitter.id)),
    );
    const answers = [];
    for (const id of ids)
      answers.push(await f.on(0, reviewer).post(`/v1/site/skills/registry/${id}/rerun-evals`, {}));
    expect(answers.slice(0, 3).map((a) => a.status)).toEqual([202, 202, 202]);
    expect([answers[3]?.status, answers[3]?.json.code]).toEqual([409, "too_many_evals"]);
    await bench.closeEvals(registryTeam);
    // A completed card names its package: one for another package is never stored.
    const completed = await admin().query<{ scorecard: unknown; id: string }>(
      `SELECT id, scorecard FROM skill_eval_runs
        WHERE team_id = $1 AND status = 'completed' AND scorecard IS NOT NULL LIMIT 1`,
      [registryTeam],
    );
    const row = completed.rows[0];
    if (!row) throw new Error("no completed re-run");
    const stored = await withTeam(f.fx.db, registryTeam, (tx) =>
      recordAuthoritativeScorecard(tx, {
        teamId: registryTeam,
        evalRunId: row.id,
        versionId: ids[0] as string,
        card: skillEvalScorecardSchema.parse(row.scorecard),
        judgeModel: { alias: "fast", source: "site" },
        startedBy: reviewer.id,
      }),
    );
    expect(stored).toBe(false);
  });
});
