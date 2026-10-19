import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { TestBrowser } from "./testing/browser.js";
import { openHarness, type Harness } from "./testing/harness.js";
import { MemoryObjects } from "./testing/memory-objects.js";
import {
  authoritative,
  promoteTeamVersion,
  readyTeamVersion,
} from "./testing/registry-fixtures.js";

/**
 * KOBE-334 (SK22, SK23): the Registry review console. The queue with semver bumps and changed
 * files; the review screen's diff against the approved version and its evidence; claims, comments
 * and decisions with the first decision winning; Approve failing closed (Registry team, the
 * authoritative scorecard, separation of duties, the submitter's right to the name); the first
 * maintainer; Request changes back to the author's Workbench with an email; Reject and block for
 * Site admins only; and names freed when a never-approved skill's submission is rejected.
 */
const dev = randomUUID();
const ops = randomUUID();
const objects = new MemoryObjects();
let h: Harness;
const ids = {
  admin1: "",
  admin2: "",
  reviewer: "",
  author: "",
  builder: "",
  member: "",
  squatter: "",
};
type Who = keyof typeof ids;
const as = {} as Record<Who, TestBrowser>;
const email = (who: Who) => `${who}@review.test`;

beforeAll(async () => {
  h = await openHarness({ blobs: { objects, prefix: "kobe/" } });
  for (const who of Object.keys(ids) as Who[])
    ids[who] = await h.createUser(email(who), who.startsWith("admin") ? "admin" : undefined);
  await h.admin.query(
    `INSERT INTO teams (id, slug, name) VALUES ($1, 'dev', 'Dev'), ($2, 'ops', 'Ops')`,
    [dev, ops],
  );
  await h.admin.query(
    `INSERT INTO team_members (team_id, user_id, role) VALUES
       ($1, $2, 'team_admin'), ($1, $3, 'team_admin'), ($1, $4, 'builder'), ($1, $5, 'member'),
       ($6, $7, 'team_admin')`,
    [dev, ids.author, ids.admin1, ids.builder, ids.member, ops, ids.squatter],
  );
  for (const who of Object.keys(ids) as Who[]) {
    as[who] = await h.signIn(email(who));
    const team = who === "squatter" ? ops : ["admin2", "reviewer"].includes(who) ? null : dev;
    if (team) {
      expect((await as[who].put("/v1/me/teams/active", { teamId: team })).status).toBe(200);
      as[who].team = team;
    }
  }
  const grant = await as.admin1.put(`/v1/site/roles/grants/${ids.reviewer}/skill_reviewer`, {});
  expect(grant.status, JSON.stringify(grant.json)).toBe(200);
  await h.admin.query(
    `INSERT INTO egress_domains (domain, in_ceiling) VALUES ('pypi.org', true)
     ON CONFLICT (domain) DO UPDATE SET in_ceiling = true`,
  );
});

afterAll(async () => {
  await h?.close();
});

/** A ready team version promoted by `who` (a Team admin in its team). */
async function submitted(who: Who, name: string, semver: string, body?: string, egress?: string[]) {
  const team = who === "squatter" ? ops : dev;
  const made = await readyTeamVersion(h, as[who], team, ids[who], name, semver, {
    ...(body ? { body } : {}),
    ...(egress ? { egress } : {}),
  });
  return { ...made, id: await promoteTeamVersion(as[who], made.skillId, made.version) };
}

const decision = (who: Who, id: string, action: string, extra: object = {}) =>
  as[who].post(`/v1/site/skills/registry/${id}/decision`, { action, ...extra });

const audit = async (action: string) =>
  (
    await h.admin.query<{ actor_id: string; target: Record<string, unknown> }>(
      `SELECT actor_id, target FROM audit_log WHERE action = $1 ORDER BY seq`,
      [action],
    )
  ).rows;

describe("Approve fails closed (KOBE-334 must-dos 1 and 6)", () => {
  it("refuses until the Registry team exists, then until the authoritative scorecard is there", async () => {
    const v = await submitted("author", "first-skill", "0.1.0");
    await authoritative(h, v.id);
    const early = await decision("admin2", v.id, "approve");
    expect([early.status, early.json.code]).toEqual([409, "registry_not_ready"]);
    const team = await as.admin1.post("/v1/site/skills/registry/team", {
      name: "Registry",
      slug: "registry",
    });
    expect(team.status, JSON.stringify(team.json)).toBe(201);

    const w = await submitted("author", "second-skill", "0.1.0");
    const detail = await as.admin2.get(`/v1/site/skills/registry/${w.id}`);
    expect((detail.json.approveProblems as { code: string }[]).map((p) => p.code)).toEqual([
      "authoritative_scorecard_missing",
    ]);
    const missing = await decision("admin2", w.id, "approve");
    expect([missing.status, missing.json.code]).toEqual([409, "authoritative_scorecard_missing"]);
    expect(missing.json.message).toMatch(/authoritative scorecard missing/i);
    const row = await h.admin.query(`SELECT state FROM registry_versions WHERE id = $1`, [w.id]);
    expect(row.rows[0]?.state).toBe("submitted");

    // Now it may: the first approval makes the submitter the first maintainer (must-do 2).
    const ok = await decision("admin2", v.id, "approve", { note: "Looks right." });
    expect(ok.status, JSON.stringify(ok.json)).toBe(200);
    expect(ok.json).toMatchObject({ state: "approved", selfApproved: false });
    const maintainers = await as.member.get(
      `/v1/skills/catalog/${await skillOf(v.id)}/maintainers`,
    );
    expect((maintainers.json.maintainers as { userId: string }[]).map((m) => m.userId)).toEqual([
      ids.author,
    ]);
    expect((await audit("registry.approved")).at(-1)).toMatchObject({
      actor_id: ids.admin2,
      target: { registryVersionId: v.id, name: "first-skill", selfApproved: false },
    });
    await h.mailer.settle();
    expect(h.mailer.to(email("author")).at(-1)?.subject).toMatch(
      /first-skill 0\.1\.0 was approved/,
    );
  });
});

async function skillOf(versionId: string): Promise<string> {
  const r = await h.admin.query<{ skill_id: string }>(
    `SELECT skill_id FROM registry_versions WHERE id = $1`,
    [versionId],
  );
  return r.rows[0]?.skill_id as string;
}

describe("the queue and the review screen (ac-1)", () => {
  it("shows the bump, the changed files and a diff against the approved version, with evidence", async () => {
    const v1 = await submitted("author", "sales-report", "0.1.0", undefined, ["pypi.org"]);
    await authoritative(h, v1.id);
    expect((await decision("admin2", v1.id, "approve")).status).toBe(200);
    const v2 = await submitted("author", "sales-report", "0.2.0", "Add a totals row and a chart.", [
      "pypi.org",
      "example.com",
    ]);
    // A look-alike name, for the hint.
    await submitted("squatter", "sales-reports", "0.1.0");

    const queue = await as.reviewer.get("/v1/site/skills/registry");
    expect(queue.status).toBe(200);
    const item = (queue.json.items as Record<string, unknown>[]).find((i) => i.id === v2.id);
    expect(item).toMatchObject({
      skill: { name: "sales-report" },
      semver: "0.2.0",
      previous: { id: v1.id, semver: "0.1.0" },
      bump: "minor",
      changedFiles: 2,
      state: "submitted",
      submittedBy: { id: ids.author },
      claimedBy: null,
      authoritativeScorecard: false,
    });
    const fresh = (queue.json.items as Record<string, unknown>[]).find(
      (i) => (i.skill as { name: string }).name === "sales-reports",
    );
    expect(fresh).toMatchObject({ bump: "new", changedFiles: 5, previous: null });

    const diff = await as.reviewer.get(`/v1/site/skills/registry/${v2.id}/diff`);
    expect(diff.status, JSON.stringify(diff.json)).toBe(200);
    expect(diff.json.against).toEqual({ id: v1.id, semver: "0.1.0" });
    const files = diff.json.files as {
      path: string;
      status: string;
      hunks: { lines: string[] }[];
    }[];
    expect(files.slice(0, 2).map((f) => [f.path, f.status])).toEqual([
      ["SKILL.md", "changed"],
      ["kobe.skill.yaml", "changed"],
    ]);
    expect(files[0]?.hunks[0]?.lines).toEqual(
      expect.arrayContaining(["-Add a totals row.", "+Add a totals row and a chart."]),
    );

    const detail = await as.reviewer.get(`/v1/site/skills/registry/${v2.id}`);
    expect(detail.status).toBe(200);
    expect(detail.json).toMatchObject({
      verdict: expect.any(String),
      scan: { findings: expect.any(Array) },
      scorecard: { packageHash: expect.any(String) },
      authoritativeScorecard: null,
      capabilities: {
        egress: [
          { host: "pypi.org", inCeiling: true },
          { host: "example.com", inCeiling: false },
        ],
      },
      provenance: { submitter: { userId: ids.author }, source: { scope: "team", teamId: dev } },
      source: { teamId: dev, teamName: "Dev" },
      similarNames: ["sales-reports"],
      skill: { maintainers: [{ userId: ids.author }] },
      previous: { semver: "0.1.0" },
      bump: "minor",
    });
    expect((detail.json.checklist as { id: string }[]).map((c) => c.id)).toEqual([
      "instructions_match",
      "no_prerequisites",
      "scripts_explained",
      "no_secrets",
    ]);
    expect((detail.json.events as { action: string }[]).map((e) => e.action)).toEqual([
      "submitted",
    ]);
  });

  it("is for reviewers and Site admins only", async () => {
    for (const who of ["member", "author", "builder"] as Who[])
      expect((await as[who].get("/v1/site/skills/registry")).status, who).toBe(403);
    expect((await as.admin1.get("/v1/site/skills/registry?state=all")).status).toBe(200);
    expect((await as.reviewer.get("/v1/site/skills/registry?state=nope")).status).toBe(400);
  });
});

describe("separation of duties and reviewer limits (ac-2)", () => {
  it("refuses the submitter and the confirming Team admin; another reviewer approves", async () => {
    const own = await submitted("admin1", "admin-own", "0.1.0");
    await authoritative(h, own.id);
    const self = await decision("admin1", own.id, "approve");
    expect([self.status, self.json.code]).toEqual([403, "own_submission"]);
    expect((await decision("admin1", own.id, "reject")).json.code).toBe("own_submission");
    expect((await as.admin1.post(`/v1/site/skills/registry/${own.id}/claim`, {})).status).toBe(403);

    // A Builder's promotion, confirmed by admin1 as Team admin.
    const made = await readyTeamVersion(h, as.builder, dev, ids.author, "builder-skill", "0.1.0");
    const req = await as.builder.post("/v1/skills/promotions", {
      scope: "team",
      skillId: made.skillId,
      version: made.version,
    });
    expect(req.status, JSON.stringify(req.json)).toBe(202);
    const confirmed = await as.admin1.post(
      `/v1/team/skill-promotions/${req.json.requestId as string}/confirm`,
      {},
    );
    expect(confirmed.status, JSON.stringify(confirmed.json)).toBe(201);
    const id = confirmed.json.registryVersionId as string;
    await authoritative(h, id);
    const byConfirmer = await decision("admin1", id, "approve");
    expect([byConfirmer.status, byConfirmer.json.code]).toEqual([403, "confirmed_by_you"]);
    const byReviewer = await decision("reviewer", id, "approve");
    expect(byReviewer.status, JSON.stringify(byReviewer.json)).toBe(200);
    // The Builder is the submitter, so the first maintainer.
    const maintainers = await as.member.get(`/v1/skills/catalog/${await skillOf(id)}/maintainers`);
    expect((maintainers.json.maintainers as { userId: string }[]).map((m) => m.userId)).toEqual([
      ids.builder,
    ]);
  });

  it("lets Skill reviewers decide but never block", async () => {
    const v = await submitted("author", "block-me", "0.1.0");
    const blocked = await decision("reviewer", v.id, "reject_and_block", { note: "Malware." });
    expect(blocked.status).toBe(403);
    const ok = await decision("admin2", v.id, "reject_and_block", { note: "Malware." });
    expect(ok.status, JSON.stringify(ok.json)).toBe(200);
    const runtime = await h.admin.query<{ runtime_hash: string; state: string }>(
      `SELECT runtime_hash, state FROM registry_versions WHERE id = $1`,
      [v.id],
    );
    expect(runtime.rows[0]?.state).toBe("rejected");
    const listed = await h.admin.query(`SELECT 1 FROM skill_blocklist WHERE content_hash = $1`, [
      runtime.rows[0]?.runtime_hash,
    ]);
    expect(listed.rows).toHaveLength(1);
    expect((await audit("registry.rejected")).at(-1)).toMatchObject({
      target: { registryVersionId: v.id, blocked: true },
    });
  });
});

describe("what the scanner and the blocklist say (SK32, D22)", () => {
  it("refuses a blocklisted package, and leaves a Block verdict to Site admins", async () => {
    const v = await submitted("author", "listed-skill", "0.1.0");
    await authoritative(h, v.id);
    await h.admin.query(
      `INSERT INTO skill_blocklist (content_hash, reason, added_by)
       SELECT runtime_hash, 'test', $2 FROM registry_versions WHERE id = $1`,
      [v.id, ids.admin1],
    );
    const listed = await decision("admin2", v.id, "approve");
    expect([listed.status, listed.json.code]).toEqual([409, "blocked"]);

    const w = await submitted("author", "block-verdict", "0.1.0");
    await authoritative(h, w.id);
    await h.admin.query(`UPDATE registry_versions SET verdict = 'block' WHERE id = $1`, [w.id]);
    const byReviewer = await decision("reviewer", w.id, "approve");
    expect([byReviewer.status, byReviewer.json.code]).toEqual([403, "block_verdict"]);
    const byAdmin = await decision("admin2", w.id, "approve", {
      note: "Reviewed: false positive.",
    });
    expect(byAdmin.status, JSON.stringify(byAdmin.json)).toBe(200);
    expect((await audit("registry.approved")).at(-1)).toMatchObject({
      target: { registryVersionId: w.id, verdict: "block" },
    });
  });
});

describe("claims and the first decision (ac-2)", () => {
  it("holds a claimed version for its reviewer; a Site admin can release it", async () => {
    const v = await submitted("author", "claimed-skill", "0.1.0");
    await authoritative(h, v.id);
    const claimed = await as.reviewer.post(`/v1/site/skills/registry/${v.id}/claim`, {});
    expect(claimed.json).toMatchObject({ state: "in_review" });
    await h.mailer.settle();
    expect(h.mailer.to(email("author")).at(-1)?.subject).toMatch(
      /claimed-skill 0\.1\.0 is in review/,
    );
    const held = await decision("admin2", v.id, "approve");
    expect([held.status, held.json.code]).toEqual([409, "claimed"]);
    const released = await as.admin2.delete(`/v1/site/skills/registry/${v.id}/claim`);
    expect(released.json).toMatchObject({ state: "submitted" });
    const approved = await decision("admin2", v.id, "approve");
    expect(approved.status).toBe(200);
    const late = await decision("reviewer", v.id, "reject");
    expect([late.status, late.json.code]).toEqual([409, "decided"]);
  });

  it("lets exactly one of two racing decisions through", async () => {
    const v = await submitted("author", "race-skill", "0.1.0");
    await authoritative(h, v.id);
    const [a, b] = await Promise.all([
      decision("admin2", v.id, "approve"),
      decision("reviewer", v.id, "reject"),
    ]);
    expect([a.status, b.status].sort()).toEqual([200, 409]);
  });
});

describe("Request changes reaches the author (ac-3)", () => {
  it("needs a note, shows it in the author's submissions and emails it", async () => {
    const v = await submitted("author", "needs-work", "0.1.0");
    expect((await decision("reviewer", v.id, "request_changes")).status).toBe(400);
    const sent = await decision("reviewer", v.id, "request_changes", {
      note: "Explain the script.",
      checklist: { scripts_explained: false, no_secrets: true },
    });
    expect(sent.json).toMatchObject({ state: "changes_requested" });
    const mine = await as.author.get("/v1/me/skill-submissions");
    expect(
      (mine.json.submissions as Record<string, unknown>[]).find((s) => s.id === v.id),
    ).toMatchObject({
      name: "needs-work",
      state: "changes_requested",
      notes: [{ action: "changes_requested", note: "Explain the script." }],
    });
    // Others don't see it in theirs.
    const theirs = await as.builder.get("/v1/me/skill-submissions");
    expect((theirs.json.submissions as { id: string }[]).some((s) => s.id === v.id)).toBe(false);
    await h.mailer.settle();
    const mail = h.mailer.to(email("author")).at(-1);
    expect(mail?.subject).toMatch(/needs-work 0\.1\.0 needs changes/);
    expect(mail?.text).toContain("Explain the script.");
    // The author revises: a new version goes into the queue as a new submission.
    const next = await submitted("author", "needs-work", "0.1.1", "Explained.");
    const row = await h.admin.query(`SELECT state FROM registry_versions WHERE id = $1`, [next.id]);
    expect(row.rows[0]?.state).toBe("submitted");
  });
});

describe("names come free (KOBE-334 must-do 3)", () => {
  it("frees a never-approved name once its submission is rejected", async () => {
    const squat = await submitted("squatter", "popular-name", "0.1.0");
    const made = await readyTeamVersion(h, as.author, dev, ids.author, "popular-name", "0.2.0");
    const taken = await as.author.post("/v1/skills/promotions", {
      scope: "team",
      skillId: made.skillId,
      version: made.version,
    });
    expect((taken.json.refusals as { code: string }[]).map((r) => r.code)).toContain("taken");
    expect((await decision("admin2", squat.id, "reject", { note: "Squatting." })).status).toBe(200);
    const id = await promoteTeamVersion(as.author, made.skillId, made.version);
    await authoritative(h, id);
    // The squatter can't come back while the author's submission is open, nor after approval.
    const back = await readyTeamVersion(h, as.squatter, ops, ids.squatter, "popular-name", "0.3.0");
    const refused = await as.squatter.post("/v1/skills/promotions", {
      scope: "team",
      skillId: back.skillId,
      version: back.version,
    });
    expect((refused.json.refusals as { code: string }[]).map((r) => r.code)).toContain("taken");
    expect((await decision("reviewer", id, "approve")).status).toBe(200);
    const maintainers = await as.member.get(`/v1/skills/catalog/${await skillOf(id)}/maintainers`);
    expect((maintainers.json.maintainers as { userId: string }[]).map((m) => m.userId)).toEqual([
      ids.author,
    ]);
    const after = await as.squatter.post("/v1/skills/promotions", {
      scope: "team",
      skillId: back.skillId,
      version: back.version,
    });
    expect((after.json.refusals as { code: string }[]).map((r) => r.code)).toContain(
      "not_maintainer",
    );
  });
});

describe("every catalog version is reviewed by a human (ac-4)", () => {
  it("has no path to approved without a reviewer", async () => {
    const v = await submitted("author", "no-shortcut", "0.1.0");
    const row = await h.admin.query(`SELECT state FROM registry_versions WHERE id = $1`, [v.id]);
    expect(row.rows[0]?.state).toBe("submitted");
    await expect(
      h.admin.query(
        `UPDATE registry_versions SET state = 'approved', approved_at = now() WHERE id = $1`,
        [v.id],
      ),
    ).rejects.toThrow(/registry_versions_approval/);
  });
});
