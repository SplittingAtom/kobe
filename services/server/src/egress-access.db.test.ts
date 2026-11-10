import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { teamMembers, withTeam } from "@kobe/db";
import { runWithAuditContext } from "./audit/context.js";
import { createTeamWithAdmin } from "./teams/members.js";
import type { TestBrowser } from "./testing/browser.js";
import { openHarness, type Harness } from "./testing/harness.js";

/**
 * KOBE-602 (egress access from the conversation, EA1-EA4): requests for hosts outside the ceiling
 * (site scope, site admins told), internal requests, and decisions from the card with the EA2/EA3
 * rules enforced on the server; the ceiling's internal flag.
 */
let h: Harness;
const ids = { site: "", alice: "", bob: "", carol: "", dave: "" };
let as: Record<keyof typeof ids, TestBrowser>;
let finance = "";
let marketing = "";

const REQUESTS = "/v1/egress/requests";
const CEILING = "/v1/site/egress-ceiling";
const enc = encodeURIComponent;
const asUser = <T>(userId: string, fn: () => Promise<T>) =>
  runWithAuditContext({ actor: { kind: "user", id: userId }, ip: null, userAgent: null }, fn);

async function audit(
  action: string,
): Promise<{ team_id: string | null; target: Record<string, unknown> }[]> {
  const { rows } = await h.admin.query(
    `SELECT team_id, target FROM audit_log WHERE action = $1 ORDER BY seq`,
    [action],
  );
  return rows;
}

async function ceilingRow(domain: string) {
  const { rows } = await h.admin.query(
    `SELECT in_ceiling, internal FROM egress_domains WHERE domain = $1`,
    [domain],
  );
  return rows[0] as { in_ceiling: boolean; internal: boolean } | undefined;
}

async function enabled(teamId: string, domain: string): Promise<boolean> {
  const { rows } = await h.admin.query(
    `SELECT 1 FROM team_egress WHERE team_id = $1 AND domain = $2`,
    [teamId, domain],
  );
  return rows.length > 0;
}

beforeAll(async () => {
  h = await openHarness();
  // `site` is a site admin and a plain member of Finance; alice is Finance's team admin.
  ids.site = await h.createUser("site@ea.test", "admin");
  ids.alice = await h.createUser("alice@ea.test");
  ids.bob = await h.createUser("bob@ea.test");
  ids.carol = await h.createUser("carol@ea.test");
  ids.dave = await h.createUser("dave@ea.test");
  const db = h.deps.database.db;
  finance = (
    await asUser(ids.alice, () =>
      createTeamWithAdmin(db, { slug: "finance", name: "Finance" }, ids.alice),
    )
  ).id;
  marketing = (
    await asUser(ids.dave, () =>
      createTeamWithAdmin(db, { slug: "marketing", name: "Marketing" }, ids.dave),
    )
  ).id;
  await withTeam(db, finance, (tx) =>
    tx.insert(teamMembers).values([
      { teamId: finance, userId: ids.bob, role: "member" },
      { teamId: finance, userId: ids.carol, role: "member" },
      { teamId: finance, userId: ids.site, role: "member" },
    ]),
  );
  as = {
    site: await h.signIn("site@ea.test"),
    alice: await h.signIn("alice@ea.test"),
    bob: await h.signIn("bob@ea.test"),
    carol: await h.signIn("carol@ea.test"),
    dave: await h.signIn("dave@ea.test"),
  };
  for (const [who, team] of [
    ["site", finance],
    ["alice", finance],
    ["bob", finance],
    ["carol", finance],
    ["dave", marketing],
  ] as const) {
    expect((await as[who].put("/v1/me/teams/active", { teamId: team })).status).toBe(200);
    as[who].team = team;
  }
  expect((await as.site.post(CEILING, { domain: "pkgs.example.com" })).status).toBe(201);
}, 120_000);
afterAll(() => h.close());

describe("requests outside the ceiling (EA1)", () => {
  it("records a site-scope request and tells the site admins, not the team admins", async () => {
    const before = h.mailer.to("alice@ea.test").length;
    const res = await as.bob.post(REQUESTS, { domain: "api.vendor.example.org" });
    expect(res.status, JSON.stringify(res.json)).toBe(201);
    expect(res.json.request).toMatchObject({
      domain: "api.vendor.example.org",
      pattern: "api.vendor.example.org",
      scope: "site",
      internal: false,
      status: "pending",
    });
    await h.mailer.settle();
    const mail = h.mailer.to("site@ea.test").at(-1);
    expect(mail?.subject).toBe(
      "Access request: api.vendor.example.org for the Finance team (site ceiling)",
    );
    expect(mail?.text).toContain("/admin/site/egress");
    expect(h.mailer.to("alice@ea.test").length).toBe(before);
    expect((await audit("egress.request.created")).at(-1)).toMatchObject({
      team_id: finance,
      target: { pattern: "api.vendor.example.org", scope: "site", notified: 1 },
    });
  });

  it("in the ceiling stays team scope (team admins told)", async () => {
    const res = await as.bob.post(REQUESTS, { domain: "pkgs.example.com", reason: "not_enabled" });
    expect(res.status).toBe(201);
    expect(res.json.request).toMatchObject({ scope: "team", internal: false });
    await h.mailer.settle();
    expect(h.mailer.to("alice@ea.test").at(-1)?.subject).toBe(
      "Access request: pkgs.example.com for the Finance team",
    );
  });

  it("an internal block is a site-scope internal request, even for an enabled host", async () => {
    const res = await as.carol.post(REQUESTS, {
      domain: "loan.apps.example.com",
      reason: "forbidden_address",
    });
    expect(res.status).toBe(201);
    expect(res.json.request).toMatchObject({ scope: "site", internal: true });
  });

  it("lists scope and internal on the member's own and the site's lists", async () => {
    const mine = await as.bob.get(REQUESTS);
    expect(mine.json.requests.every((r: { scope: string }) => r.scope)).toBe(true);
    const site = await as.site.get(`${CEILING}/requests`);
    expect(site.status).toBe(200);
    expect(
      site.json.requests.map((r: { domain: string; team: { name: string } }) => [
        r.domain,
        r.team.name,
      ]),
    ).toEqual(
      expect.arrayContaining([
        ["api.vendor.example.org", "Finance"],
        ["loan.apps.example.com", "Finance"],
      ]),
    );
    expect(
      site.json.requests.some((r: { domain: string }) => r.domain === "pkgs.example.com"),
    ).toBe(false);
    expect((await as.alice.get(`${CEILING}/requests`)).status).toBe(403);
  });
});

describe("decisions from the card (EA2, EA3)", () => {
  const mineFor = async (who: TestBrowser, domain: string): Promise<string> => {
    const res = await who.get(`${REQUESTS}?domain=${domain}`);
    return res.json.requests[0].id as string;
  };

  it("members and other teams can't decide", async () => {
    const id = await mineFor(as.bob, "api.vendor.example.org");
    const member = await as.carol.post(`${REQUESTS}/${id}/decision`, { decision: "approve" });
    expect(member.status).toBe(403);
    const other = await as.dave.post(`${REQUESTS}/${id}/decision`, { decision: "deny" });
    expect(other.status).toBe(404);
  });

  it("a team admin can't decide a site-scope request nor mark anything internal", async () => {
    const id = await mineFor(as.bob, "api.vendor.example.org");
    const res = await as.alice.post(`${REQUESTS}/${id}/decision`, { decision: "deny" });
    expect(res.status).toBe(403);
    expect(res.json.code).toBe("site_admin_required");
    const team = await mineFor(as.bob, "pkgs.example.com");
    const internal = await as.alice.post(`${REQUESTS}/${team}/decision`, {
      decision: "approve",
      internal: true,
    });
    expect(internal.status).toBe(403);
    expect(internal.json.code).toBe("internal_not_allowed");
    // The team console refuses site-scope requests the same way.
    const viaConsole = await as.alice.post(`/v1/team/egress/requests/${id}`, { decision: "deny" });
    expect(viaConsole.json.code).toBe("site_admin_required");
  });

  it("a team admin approves a team-scope request within the ceiling only", async () => {
    const id = await mineFor(as.bob, "pkgs.example.com");
    const outside = await as.alice.post(`${REQUESTS}/${id}/decision`, {
      decision: "approve",
      pattern: "*.example.com",
    });
    expect(outside.status).toBe(409);
    expect(outside.json.code).toBe("not_in_ceiling");
    const res = await as.alice.post(`${REQUESTS}/${id}/decision`, { decision: "approve" });
    expect(res.status, JSON.stringify(res.json)).toBe(200);
    expect(res.json).toMatchObject({
      enabled: true,
      pattern: "pkgs.example.com",
      ceiling: null,
      internal: false,
      request: { status: "approved" },
    });
    expect(await enabled(finance, "pkgs.example.com")).toBe(true);
    expect((await audit("egress.request.decided")).at(-1)?.target).toMatchObject({
      by: "team_admin",
      decision: "approved",
    });
  });

  it("refuses patterns that don't cover the host, public suffixes and junk", async () => {
    const id = await mineFor(as.bob, "api.vendor.example.org");
    for (const [pattern, code] of [
      ["other.example.org", "pattern_not_covering"],
      ["*.api.vendor.example.org", "pattern_not_covering"],
      ["*.org", "invalid_pattern"],
      ["*.co.uk", "invalid_pattern"],
      ["https://x/", "invalid_pattern"],
    ] as const) {
      const res = await as.site.post(`${REQUESTS}/${id}/decision`, {
        decision: "approve",
        pattern,
      });
      expect(res.status, pattern).toBe(422);
      expect(res.json.code, pattern).toBe(code);
    }
    expect((await as.site.post(`${REQUESTS}/${id}/decision`, { decision: "maybe" })).status).toBe(
      400,
    );
  });

  it("a site admin approves with a parent wildcard: ceiling + team enablement, covered requests settled", async () => {
    // Carol asks for a sibling host: the wildcard settles it with Bob's.
    expect((await as.carol.post(REQUESTS, { domain: "files.vendor.example.org" })).status).toBe(
      201,
    );
    const id = await mineFor(as.bob, "api.vendor.example.org");
    const res = await as.site.post(`${REQUESTS}/${id}/decision`, {
      decision: "approve",
      pattern: "*.vendor.example.org",
    });
    expect(res.status, JSON.stringify(res.json)).toBe(200);
    expect(res.json).toMatchObject({
      pattern: "*.vendor.example.org",
      ceiling: "added",
      enabled: true,
      internal: false,
      settled: 2,
      request: { status: "approved" },
    });
    expect(await ceilingRow("*.vendor.example.org")).toEqual({ in_ceiling: true, internal: false });
    expect(await enabled(finance, "*.vendor.example.org")).toBe(true);
    expect(await enabled(marketing, "*.vendor.example.org")).toBe(false);
    expect((await audit("egress.ceiling.added")).at(-1)?.target).toEqual({
      domain: "*.vendor.example.org",
    });
    expect((await audit("egress.request.decided")).at(-1)?.target).toMatchObject({
      pattern: "*.vendor.example.org",
      requested: "api.vendor.example.org",
      by: "site_admin",
      requests: 2,
    });
    await h.mailer.settle();
    // Each requester hears about what they asked for (now covered by the wildcard).
    expect(h.mailer.to("carol@ea.test").at(-1)?.subject).toBe(
      "files.vendor.example.org is now enabled for the Finance team",
    );
    // Deciding again: already decided. A new request for a covered host: already enabled.
    expect((await as.site.post(`${REQUESTS}/${id}/decision`, { decision: "deny" })).status).toBe(
      409,
    );
    const again = await as.bob.post(REQUESTS, { domain: "x.vendor.example.org" });
    expect(again.status).toBe(409);
    expect(again.json.code).toBe("already_enabled");
  });

  it("a site admin marks an internal request's pattern internal", async () => {
    const id = await mineFor(as.carol, "loan.apps.example.com");
    const res = await as.site.post(`${REQUESTS}/${id}/decision`, {
      decision: "approve",
      pattern: "*.apps.example.com",
      internal: true,
    });
    expect(res.status, JSON.stringify(res.json)).toBe(200);
    expect(res.json).toMatchObject({ ceiling: "added", internal: true, enabled: true });
    expect(await ceilingRow("*.apps.example.com")).toEqual({ in_ceiling: true, internal: true });
    expect((await audit("egress.ceiling.internal_changed")).at(-1)?.target).toEqual({
      domain: "*.apps.example.com",
      internal: true,
    });
    // Now enabled and internal: nothing left to ask for.
    const again = await as.carol.post(REQUESTS, {
      domain: "loan.apps.example.com",
      reason: "forbidden_address",
    });
    expect(again.json.code).toBe("already_enabled");
  });

  it("a site admin denies: nothing allowed, the requester told", async () => {
    const req = await as.bob.post(REQUESTS, { domain: "tracker.example.net" });
    expect(req.json.request.scope).toBe("site");
    const res = await as.site.post(`${REQUESTS}/${req.json.request.id}/decision`, {
      decision: "deny",
    });
    expect(res.status).toBe(200);
    expect(res.json).toMatchObject({
      enabled: false,
      ceiling: null,
      request: { status: "denied" },
    });
    expect(await ceilingRow("tracker.example.net")).toBeUndefined();
  });

  it("the Site console decides any team's request by team and id", async () => {
    const req = await as.dave.post(REQUESTS, { domain: "cdn.vendor2.example.org" });
    expect(req.status).toBe(201);
    const id = req.json.request.id as string;
    expect(
      (await as.alice.post(`${CEILING}/requests/${marketing}/${id}/decision`, { decision: "deny" }))
        .status,
    ).toBe(403);
    expect(
      (await as.site.post(`${CEILING}/requests/${finance}/${id}/decision`, { decision: "deny" }))
        .status,
    ).toBe(404);
    const res = await as.site.post(`${CEILING}/requests/${marketing}/${id}/decision`, {
      decision: "approve",
    });
    expect(res.status, JSON.stringify(res.json)).toBe(200);
    expect(await enabled(marketing, "cdn.vendor2.example.org")).toBe(true);
  });
});

describe("the ceiling's internal flag (EA4)", () => {
  it("is listed and toggled by site admins only, audited", async () => {
    const list = await as.site.get(CEILING);
    const row = list.json.domains.find((d: { domain: string }) => d.domain === "pkgs.example.com");
    expect(row).toMatchObject({ in_ceiling: true, internal: false });
    const put = await as.site.put(`${CEILING}/${enc("pkgs.example.com")}`, { internal: true });
    expect(put.status).toBe(200);
    expect(put.json.domain).toMatchObject({ in_ceiling: true, internal: true });
    expect((await audit("egress.ceiling.internal_changed")).at(-1)?.target).toEqual({
      domain: "pkgs.example.com",
      internal: true,
    });
    expect((await as.site.put(`${CEILING}/${enc("pkgs.example.com")}`, {})).status).toBe(400);
    expect(
      (await as.alice.put(`${CEILING}/${enc("pkgs.example.com")}`, { internal: false })).status,
    ).toBe(403);
    const both = await as.site.put(`${CEILING}/${enc("pkgs.example.com")}`, {
      in_ceiling: true,
      internal: false,
    });
    expect(both.json.domain).toMatchObject({ in_ceiling: true, internal: false });
  });
});
