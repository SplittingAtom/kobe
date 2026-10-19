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
 * KOBE-334 (SK22): a single-admin Site may approve its own submission, flagged, as with
 * break-glass (D10), and the promotion it confirmed as Team admin; once a second reviewer exists,
 * it may not.
 */
const team = randomUUID();
const objects = new MemoryObjects();
let h: Harness;
let admin: TestBrowser;
let builder: TestBrowser;
const ids = { admin: "", builder: "", reviewer: "" };

beforeAll(async () => {
  h = await openHarness({ blobs: { objects, prefix: "kobe/" } });
  ids.admin = await h.createUser("admin@solo.test", "admin");
  ids.builder = await h.createUser("builder@solo.test");
  ids.reviewer = await h.createUser("reviewer@solo.test");
  await h.admin.query(`INSERT INTO teams (id, slug, name) VALUES ($1, 'solo', 'Solo')`, [team]);
  await h.admin.query(
    `INSERT INTO team_members (team_id, user_id, role) VALUES ($1, $2, 'team_admin'), ($1, $3, 'builder')`,
    [team, ids.admin, ids.builder],
  );
  admin = await h.signIn("admin@solo.test");
  builder = await h.signIn("builder@solo.test");
  for (const b of [admin, builder]) {
    expect((await b.put("/v1/me/teams/active", { teamId: team })).status).toBe(200);
    b.team = team;
  }
  const made = await admin.post("/v1/site/skills/registry/team", { name: "Reg", slug: "reg" });
  expect(made.status, JSON.stringify(made.json)).toBe(201);
});

afterAll(async () => {
  await h?.close();
});

const approve = (id: string) =>
  admin.post(`/v1/site/skills/registry/${id}/decision`, { action: "approve" });

describe("a single-admin Site (SK22)", () => {
  it("self-approves, flagged; then a second reviewer takes that away", async () => {
    const v = await readyTeamVersion(h, admin, team, ids.admin, "solo-skill", "0.1.0");
    const id = await promoteTeamVersion(admin, v.skillId, v.version);
    await authoritative(h, id);
    // A Caution finding: the single admin acknowledges its own (review-335 M1 exception).
    await h.admin.query(
      `UPDATE registry_versions SET verdict = 'caution', scan = jsonb_set(scan, '{findings}',
         '[{"rule": "prerequisite", "file": "SKILL.md", "line": 2, "severity": "caution"}]')
        WHERE id = $1`,
      [id],
    );
    const ack = await admin.post(`/v1/site/skills/registry/${id}/acknowledgements`, {
      finding: "prerequisite@SKILL.md:2",
    });
    expect(ack.status, JSON.stringify(ack.json)).toBe(200);
    const claimed = await admin.post(`/v1/site/skills/registry/${id}/claim`, {});
    expect(claimed.status, JSON.stringify(claimed.json)).toBe(200);
    const ok = await approve(id);
    expect(ok.status, JSON.stringify(ok.json)).toBe(200);
    expect(ok.json.selfApproved).toBe(true);
    const row = await h.admin.query(`SELECT self_approved FROM registry_versions WHERE id = $1`, [
      id,
    ]);
    expect(row.rows[0]?.self_approved).toBe(true);

    // The promotion it confirmed for a Builder: allowed too, and audited as such.
    const made = await readyTeamVersion(h, builder, team, ids.admin, "solo-builder", "0.1.0");
    const req = await builder.post("/v1/skills/promotions", {
      scope: "team",
      skillId: made.skillId,
      version: made.version,
    });
    const confirmed = await admin.post(
      `/v1/team/skill-promotions/${req.json.requestId as string}/confirm`,
      {},
    );
    expect(confirmed.status, JSON.stringify(confirmed.json)).toBe(201);
    const bid = confirmed.json.registryVersionId as string;
    await authoritative(h, bid);
    const ok2 = await approve(bid);
    expect(ok2.status, JSON.stringify(ok2.json)).toBe(200);
    // The version is flagged like the submitter's own (review M2), and the author sees it.
    expect(ok2.json.selfApproved).toBe(true);
    const flagged = await h.admin.query(
      `SELECT self_approved FROM registry_versions WHERE id = $1`,
      [bid],
    );
    expect(flagged.rows[0]?.self_approved).toBe(true);
    const mine = await builder.get("/v1/me/skill-submissions");
    expect(
      (mine.json.submissions as { id: string; selfApproved: boolean }[]).find((x) => x.id === bid),
    ).toMatchObject({ selfApproved: true });
    const audit = await h.admin.query<{ target: Record<string, unknown> }>(
      `SELECT target FROM audit_log WHERE action = 'registry.approved' ORDER BY seq`,
    );
    expect(audit.rows.map((r) => r.target)).toEqual([
      expect.objectContaining({ registryVersionId: id, selfApproved: true }),
      expect.objectContaining({ registryVersionId: bid, confirmerApproved: true }),
    ]);

    // A Skill reviewer appears: the admin's next own submission needs them.
    expect(
      (await admin.put(`/v1/site/roles/grants/${ids.reviewer}/skill_reviewer`, {})).status,
    ).toBe(200);
    const next = await readyTeamVersion(h, admin, team, ids.admin, "solo-skill", "0.2.0", {
      body: "Second.",
    });
    const nid = await promoteTeamVersion(admin, next.skillId, next.version);
    await authoritative(h, nid);
    const refused = await approve(nid);
    expect([refused.status, refused.json.code]).toEqual([403, "own_submission"]);
    // And what it confirms for a Builder needs the second reviewer too.
    const later = await readyTeamVersion(h, builder, team, ids.admin, "solo-builder", "0.2.0", {
      body: "Second.",
    });
    const req2 = await builder.post("/v1/skills/promotions", {
      scope: "team",
      skillId: later.skillId,
      version: later.version,
    });
    const conf2 = await admin.post(
      `/v1/team/skill-promotions/${req2.json.requestId as string}/confirm`,
      {},
    );
    const cid = conf2.json.registryVersionId as string;
    await authoritative(h, cid);
    const byConfirmer = await approve(cid);
    expect([byConfirmer.status, byConfirmer.json.code]).toEqual([403, "confirmed_by_you"]);
  });
});
