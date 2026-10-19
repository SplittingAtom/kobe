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
 * KOBE-334 review fixes: Caution findings acknowledged one by one (M1); a name held by a
 * changes-requested or retracted first submission comes free (M3); the authoritative scorecard
 * must name the package (L2); a Block override needs a note (L3); an archived skill or a
 * deactivated submitter is refused (L5); the submission right is re-checked inside the
 * submission (C3-L3).
 */
const dev = randomUUID();
const ops = randomUUID();
const objects = new MemoryObjects();
let h: Harness;
const ids = { admin: "", second: "", reviewer: "", author: "", other: "" };
type Who = keyof typeof ids;
const as = {} as Record<Who, TestBrowser>;
const email = (who: Who) => `${who}@rules.test`;

beforeAll(async () => {
  h = await openHarness({ blobs: { objects, prefix: "kobe/" } });
  for (const who of Object.keys(ids) as Who[])
    ids[who] = await h.createUser(
      email(who),
      ["admin", "second"].includes(who) ? "admin" : undefined,
    );
  await h.admin.query(
    `INSERT INTO teams (id, slug, name) VALUES ($1, 'dev', 'Dev'), ($2, 'ops', 'Ops')`,
    [dev, ops],
  );
  await h.admin.query(
    `INSERT INTO team_members (team_id, user_id, role) VALUES ($1, $2, 'team_admin'),
       ($3, $4, 'team_admin')`,
    [dev, ids.author, ops, ids.other],
  );
  for (const who of Object.keys(ids) as Who[]) {
    as[who] = await h.signIn(email(who));
    const team = who === "author" ? dev : who === "other" ? ops : null;
    if (team) {
      expect((await as[who].put("/v1/me/teams/active", { teamId: team })).status).toBe(200);
      as[who].team = team;
    }
  }
  expect(
    (await as.admin.put(`/v1/site/roles/grants/${ids.reviewer}/skill_reviewer`, {})).status,
  ).toBe(200);
  expect(
    (await as.admin.post("/v1/site/skills/registry/team", { name: "Reg", slug: "reg" })).status,
  ).toBe(201);
});

afterAll(async () => {
  await h?.close();
});

async function submitted(who: "author" | "other", name: string, semver: string, body?: string) {
  const made = await readyTeamVersion(
    h,
    as[who],
    who === "author" ? dev : ops,
    ids[who],
    name,
    semver,
    {
      ...(body ? { body } : {}),
    },
  );
  return { ...made, id: await promoteTeamVersion(as[who], made.skillId, made.version) };
}

const decision = (who: Who, id: string, action: string, extra: object = {}) =>
  as[who].post(`/v1/site/skills/registry/${id}/decision`, { action, ...extra });

const refusalCodes = async (who: "author" | "other", skillId: string, version: number) => {
  const r = await as[who].post("/v1/skills/promotions", { scope: "team", skillId, version });
  return r.status === 201 ? [] : ((r.json.refusals as { code: string }[]) ?? []).map((x) => x.code);
};

const caution = (rule: string, line: number) => ({
  category: "prose",
  rule,
  file: "SKILL.md",
  line,
  excerpt: "",
  severity: "caution",
});

describe("Caution findings are acknowledged one by one (review M1)", () => {
  it("refuses Approve until each is acknowledged, and records each", async () => {
    const v = await submitted("author", "cautious", "0.1.0");
    await authoritative(h, v.id);
    await h.admin.query(
      `UPDATE registry_versions SET verdict = 'caution',
         scan = jsonb_set(scan, '{findings}', $2::jsonb) WHERE id = $1`,
      [v.id, JSON.stringify([caution("prerequisite", 3), caution("invisible", 7)])],
    );
    const detail = await as.reviewer.get(`/v1/site/skills/registry/${v.id}`);
    const keys = (detail.json.findings as { key: string; acknowledged: unknown }[]).map(
      (f) => f.key,
    );
    expect(keys).toEqual(["prerequisite@SKILL.md:3", "invisible@SKILL.md:7"]);
    const none = await decision("reviewer", v.id, "approve");
    expect([none.status, none.json.code]).toEqual([409, "findings_unacknowledged"]);
    const ack = (key: string) =>
      as.reviewer.post(`/v1/site/skills/registry/${v.id}/acknowledgements`, { finding: key });
    expect((await ack("nope@x:1")).status).toBe(404);
    expect((await ack(keys[0] as string)).json).toMatchObject({ changed: true });
    expect((await ack(keys[0] as string)).json).toMatchObject({ changed: false });
    const partial = await decision("reviewer", v.id, "approve");
    expect(partial.json.code).toBe("findings_unacknowledged");
    expect(partial.json.message).toMatch(/1 left/);
    await ack(keys[1] as string);
    const ok = await decision("reviewer", v.id, "approve");
    expect(ok.status, JSON.stringify(ok.json)).toBe(200);
    const events = await h.admin.query(
      `SELECT checklist ->> 'finding' AS key FROM registry_review_events
        WHERE version_id = $1 AND action = 'finding_acknowledged' ORDER BY id`,
      [v.id],
    );
    expect(events.rows.map((r) => r.key)).toEqual(keys);
    const audits = await h.admin.query(
      `SELECT action, target FROM audit_log WHERE target ->> 'registryVersionId' = $1
         AND action IN ('registry.finding_acknowledged', 'registry.approved') ORDER BY seq`,
      [v.id],
    );
    expect(audits.rows.map((r) => r.action)).toEqual([
      "registry.finding_acknowledged",
      "registry.finding_acknowledged",
      "registry.approved",
    ]);
    expect(audits.rows[2]?.target).toMatchObject({ verdict: "caution", acknowledgedFindings: 2 });
  });
});

describe("a held name comes free (review M3)", () => {
  it("after Request changes, once a reviewer rejects it", async () => {
    const squat = await submitted("other", "held-name", "0.1.0");
    expect(
      (await decision("reviewer", squat.id, "request_changes", { note: "Fix it." })).status,
    ).toBe(200);
    const mine = await readyTeamVersion(h, as.author, dev, ids.author, "held-name", "0.2.0");
    expect(await refusalCodes("author", mine.skillId, mine.version)).toContain("taken");
    // Request changes is not the end: a reviewer can still reject it.
    expect((await decision("reviewer", squat.id, "reject", { note: "Abandoned." })).status).toBe(
      200,
    );
    expect(await refusalCodes("author", mine.skillId, mine.version)).toEqual([]);
  });

  it("after its author retracts it; only the author can, and only before a decision", async () => {
    const squat = await submitted("other", "retract-name", "0.1.0");
    const byOther = await as.author.post(`/v1/me/skill-submissions/${squat.id}/retract`, {});
    expect(byOther.status).toBe(404);
    const done = await as.other.post(`/v1/me/skill-submissions/${squat.id}/retract`, {});
    expect(done.json).toMatchObject({ state: "retracted" });
    expect((await as.other.post(`/v1/me/skill-submissions/${squat.id}/retract`, {})).status).toBe(
      409,
    );
    const late = await decision("reviewer", squat.id, "reject");
    expect(late.json.code).toBe("decided");
    const mine = await readyTeamVersion(h, as.author, dev, ids.author, "retract-name", "0.2.0");
    expect(await refusalCodes("author", mine.skillId, mine.version)).toEqual([]);
    const audit = await h.admin.query(
      `SELECT actor_id FROM audit_log WHERE action = 'registry.retracted'
         AND target ->> 'registryVersionId' = $1`,
      [squat.id],
    );
    expect(audit.rows).toEqual([{ actor_id: ids.other }]);
  });
});

describe("Approve's other refusals (review L2, L3, L5)", () => {
  it("needs a scorecard naming the package, a note to override Block, a live skill and submitter", async () => {
    const v = await submitted("author", "loose-card", "0.1.0");
    await h.admin.query(
      `UPDATE registry_versions SET authoritative_scorecard = '{"cases": 5}' WHERE id = $1`,
      [v.id],
    );
    expect((await decision("admin", v.id, "approve")).json.code).toBe(
      "authoritative_scorecard_stale",
    );

    const b = await submitted("author", "block-note", "0.1.0");
    await authoritative(h, b.id);
    await h.admin.query(`UPDATE registry_versions SET verdict = 'block' WHERE id = $1`, [b.id]);
    expect((await decision("admin", b.id, "approve")).json.code).toBe("scan_override_reason");
    expect((await decision("admin", b.id, "approve", { note: "False positive." })).status).toBe(
      200,
    );
    const audit = await h.admin.query(
      `SELECT target FROM audit_log WHERE action = 'registry.approved'
         AND target ->> 'registryVersionId' = $1`,
      [b.id],
    );
    expect(audit.rows[0]?.target).toMatchObject({ verdict: "block", scanOverride: true });

    const a = await submitted("author", "archived-skill", "0.1.0");
    await authoritative(h, a.id);
    await h.admin.query(
      `UPDATE registry_skills SET status = 'archived'
        WHERE id = (SELECT skill_id FROM registry_versions WHERE id = $1)`,
      [a.id],
    );
    expect((await decision("admin", a.id, "approve")).json.code).toBe("archived");

    const d = await submitted("other", "gone-author", "0.1.0");
    await authoritative(h, d.id);
    await h.admin.query(`UPDATE users SET deactivated_at = now() WHERE id = $1`, [ids.other]);
    try {
      expect((await decision("admin", d.id, "approve")).json.code).toBe("submitter_deactivated");
    } finally {
      await h.admin.query(`UPDATE users SET deactivated_at = NULL WHERE id = $1`, [ids.other]);
    }
  });
});

describe("the submission right inside the submission (review C3-L3)", () => {
  it("refuses a maintainer removed between the preview and the submission", async () => {
    const v = await submitted("author", "kept-name", "0.1.0");
    await authoritative(h, v.id);
    expect((await decision("admin", v.id, "approve")).status).toBe(200);
    const next = await readyTeamVersion(h, as.author, dev, ids.author, "kept-name", "0.2.0", {
      body: "Second.",
    });
    // While the submission writes its catalog bytes, a Site admin hands the skill to another.
    const get = objects.get.bind(objects);
    objects.get = async (key, options) => {
      if (key.includes("skills/catalog/")) {
        objects.get = get;
        await h.admin.query(
          `INSERT INTO registry_maintainers (skill_id, user_id)
             SELECT skill_id, $2 FROM registry_versions WHERE id = $1`,
          [v.id, ids.other],
        );
        await h.admin.query(
          `DELETE FROM registry_maintainers WHERE user_id = $2
             AND skill_id = (SELECT skill_id FROM registry_versions WHERE id = $1)`,
          [v.id, ids.author],
        );
      }
      return get(key, options);
    };
    try {
      const r = await as.author.post("/v1/skills/promotions", {
        scope: "team",
        skillId: next.skillId,
        version: next.version,
      });
      expect([r.status, (r.json.refusals as { code: string }[])[0]?.code]).toEqual([
        422,
        "not_maintainer",
      ]);
    } finally {
      objects.get = get;
    }
  });
});
