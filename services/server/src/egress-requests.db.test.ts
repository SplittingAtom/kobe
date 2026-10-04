import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  EGRESS_CHANGES_CHANNEL,
  headerBox,
  openHeaders,
  teamMembers,
  threads,
  withTeam,
} from "@kobe/db";
import { runWithAuditContext } from "./audit/context.js";
import { resealTeamHeaders } from "./egress/header-store.js";
import { sweepEgressRequestNotifications } from "./egress/request-notify.js";
import { MAX_REQUESTS_PER_HOUR } from "./egress/request-store.js";
import { createTeamWithAdmin } from "./teams/members.js";
import type { TestBrowser } from "./testing/browser.js";
import { openHarness, type Harness } from "./testing/harness.js";

/**
 * KOBE-39: request access (member asks, team admin approves or denies, everyone notified, audited,
 * no self-allow) and per-team header injection (write-only, sealed, names-only audit).
 */
const HEADER_SECRET = "header-secret-for-tests-0123456789abcdef";
let h: Harness;
const ids = { owner: "", alice: "", bob: "", carol: "", dave: "" };
let as: Record<keyof typeof ids, TestBrowser>;
let finance = "";
let marketing = "";
let bobThread = "";

const asUser = <T>(userId: string, fn: () => Promise<T>) =>
  runWithAuditContext({ actor: { kind: "user", id: userId }, ip: null, userAgent: null }, fn);

async function audit(
  prefix: string,
): Promise<{ action: string; team_id: string; target: Record<string, unknown> }[]> {
  const { rows } = await h.admin.query(
    `SELECT action, team_id, target FROM audit_log WHERE action LIKE $1 ORDER BY seq`,
    [`${prefix}%`],
  );
  return rows;
}

const REQUESTS = "/v1/egress/requests";
const TEAM_REQUESTS = "/v1/team/egress/requests";
const enc = encodeURIComponent;

beforeAll(async () => {
  h = await openHarness({ egressHeaderSecrets: [HEADER_SECRET] });
  ids.owner = await h.createUser("owner@req.test", "owner");
  ids.alice = await h.createUser("alice@req.test");
  ids.bob = await h.createUser("bob@req.test");
  ids.carol = await h.createUser("carol@req.test");
  ids.dave = await h.createUser("dave@req.test");
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
    ]),
  );
  bobThread = await withTeam(db, finance, async (tx) => {
    const [t] = await tx
      .insert(threads)
      .values({ teamId: finance, ownerUserId: ids.bob, title: "pip install" })
      .returning({ id: threads.id });
    return t?.id ?? "";
  });
  as = {
    owner: await h.signIn("owner@req.test"),
    alice: await h.signIn("alice@req.test"),
    bob: await h.signIn("bob@req.test"),
    carol: await h.signIn("carol@req.test"),
    dave: await h.signIn("dave@req.test"),
  };
  for (const [who, team] of [
    ["alice", finance],
    ["bob", finance],
    ["carol", finance],
    ["dave", marketing],
  ] as const) {
    expect((await as[who].put("/v1/me/teams/active", { teamId: team })).status).toBe(200);
    as[who].team = team;
  }
  // A custom ceiling domain and a wildcard (registries are seeded in the ceiling by migration).
  expect(
    (await as.owner.post("/v1/install/egress-ceiling", { domain: "pkgs.example.com" })).status,
  ).toBe(201);
  expect(
    (await as.owner.post("/v1/install/egress-ceiling", { domain: "*.files.example.com" })).status,
  ).toBe(201);
}, 120_000);
afterAll(() => h.close());

describe("request access", () => {
  it("a member asks for a blocked host: pending, admins emailed (domain + thread metadata), audited", async () => {
    const res = await as.bob.post(REQUESTS, { domain: "PyPI.org", thread_id: bobThread });
    expect(res.status, JSON.stringify(res.json)).toBe(201);
    expect(res.json.request).toMatchObject({
      domain: "pypi.org",
      pattern: "pypi.org",
      status: "pending",
      thread_id: bobThread,
      requested_by: { id: ids.bob, name: "bob" },
    });
    await h.mailer.settle();
    const mail = h.mailer.to("alice@req.test").at(-1);
    expect(mail?.subject).toBe("Access request: pypi.org for the Finance team");
    expect(mail?.text).toContain("bob asked to enable pypi.org");
    expect(mail?.text).toContain(`Thread: ${bobThread}`);
    expect(mail?.text).toContain("/admin/team/egress");
    // Never the thread's title (content) nor anything about the request beyond metadata.
    expect(mail?.text).not.toContain("pip install");
    expect(h.mailer.to("carol@req.test")).toEqual([]);
    const [created] = await audit("egress.request.created");
    expect(created).toMatchObject({
      team_id: finance,
      target: { domain: "pypi.org", pattern: "pypi.org", threadId: bobThread, notified: 1 },
    });
  });

  it("asking again returns the same pending request (no second email)", async () => {
    const before = h.mailer.sent.length;
    const again = await as.bob.post(REQUESTS, { domain: "pypi.org" });
    expect(again.status).toBe(200);
    expect(again.json.request.status).toBe("pending");
    await h.mailer.settle();
    expect(h.mailer.sent.length).toBe(before);
  });

  it("a wildcard ceiling pattern is what the request names", async () => {
    const res = await as.carol.post(REQUESTS, { domain: "a.b.files.example.com" });
    expect(res.status).toBe(201);
    expect(res.json.request).toMatchObject({
      domain: "a.b.files.example.com",
      pattern: "*.files.example.com",
    });
  });

  it("refuses hosts outside the ceiling, junk, and other users' or unknown threads", async () => {
    const outside = await as.bob.post(REQUESTS, { domain: "evil.example.net" });
    expect(outside.status).toBe(409);
    expect(outside.json.code).toBe("not_in_ceiling");
    for (const bad of ["10.0.0.1", "https://pypi.org/simple", "a b", ""]) {
      expect((await as.bob.post(REQUESTS, { domain: bad })).status, bad).toBeGreaterThanOrEqual(
        400,
      );
    }
    // Carol can't attach Bob's thread; nor a thread id from nowhere.
    const foreign = await as.carol.post(REQUESTS, {
      domain: "pkgs.example.com",
      thread_id: bobThread,
    });
    expect(foreign.status).toBe(404);
    expect(foreign.json.code).toBe("thread_not_found");
  });

  it("members can't decide or list the team's requests (no self-allow)", async () => {
    const mine = await as.bob.get(`${REQUESTS}?domain=pypi.org`);
    expect(mine.status).toBe(200);
    const id = mine.json.requests[0].id as string;
    expect((await as.bob.get(TEAM_REQUESTS)).status).toBe(403);
    expect((await as.bob.post(`${TEAM_REQUESTS}/${id}`, { decision: "approve" })).status).toBe(403);
    expect((await as.bob.put(`/v1/team/egress/domains/pypi.org`, {})).status).toBe(403);
    // Another team's admin can't see or decide it either.
    expect((await as.dave.post(`${TEAM_REQUESTS}/${id}`, { decision: "approve" })).status).toBe(
      404,
    );
    expect((await as.dave.get(TEAM_REQUESTS)).json.requests).toEqual([]);
  });

  it("the team admin approves: the pattern is enabled (NOTIFY), every pending request settled, requesters told", async () => {
    // Carol also asked for pypi.org: one approval settles both.
    expect((await as.carol.post(REQUESTS, { domain: "pypi.org" })).status).toBe(201);
    const list = await as.alice.get(TEAM_REQUESTS);
    expect(list.status).toBe(200);
    const pypi = (
      list.json.requests as { id: string; pattern: string; requested_by: { id: string } }[]
    ).filter((r) => r.pattern === "pypi.org");
    expect(pypi.map((r) => r.requested_by.id).sort()).toEqual([ids.bob, ids.carol].sort());
    const listener = new pg.Client({ connectionString: h.appUrl });
    await listener.connect();
    const hints: string[] = [];
    listener.on("notification", (n) => hints.push(n.payload ?? ""));
    await listener.query(`LISTEN ${EGRESS_CHANGES_CHANNEL}`);
    const id = pypi[0]?.id ?? "";
    const res = await as.alice.post(`${TEAM_REQUESTS}/${id}`, { decision: "approve" });
    expect(res.status, JSON.stringify(res.json)).toBe(200);
    expect(res.json).toMatchObject({ settled: 2, enabled: true, request: { status: "approved" } });
    await new Promise((r) => setTimeout(r, 200));
    await listener.end();
    expect(hints).toContain(finance);
    const team = await as.bob.get("/v1/team/egress");
    expect(
      team.json.domains.find((d: { domain: string }) => d.domain === "pypi.org"),
    ).toMatchObject({
      enabled: true,
      enabled_by: ids.alice,
    });
    await h.mailer.settle();
    expect(h.mailer.to("bob@req.test").at(-1)?.subject).toBe(
      "pypi.org is now enabled for the Finance team",
    );
    expect(h.mailer.to("carol@req.test").at(-1)?.subject).toBe(
      "pypi.org is now enabled for the Finance team",
    );
    const mine = await as.bob.get(`${REQUESTS}?domain=pypi.org`);
    expect(mine.json.requests[0]).toMatchObject({ status: "approved", decided_by: ids.alice });
    const decided = (await audit("egress.request.decided")).at(-1);
    expect(decided?.target).toMatchObject({
      decision: "approved",
      requests: 2,
      enabled: true,
      pattern: "pypi.org",
    });
    expect((await audit("egress.domain.enabled")).at(-1)?.target).toEqual({ domain: "pypi.org" });
    // Deciding again: already decided. Asking again: already enabled.
    expect((await as.alice.post(`${TEAM_REQUESTS}/${id}`, { decision: "deny" })).status).toBe(409);
    const enabled = await as.bob.post(REQUESTS, { domain: "pypi.org" });
    expect(enabled.status).toBe(409);
    expect(enabled.json.code).toBe("already_enabled");
  });

  it("the team admin denies: nothing enabled, the requester told", async () => {
    const req = await as.bob.post(REQUESTS, { domain: "pkgs.example.com" });
    expect(req.status).toBe(201);
    const res = await as.alice.post(`${TEAM_REQUESTS}/${req.json.request.id}`, {
      decision: "deny",
    });
    expect(res.status).toBe(200);
    expect(res.json).toMatchObject({ enabled: false, request: { status: "denied" } });
    await h.mailer.settle();
    expect(h.mailer.to("bob@req.test").at(-1)?.subject).toBe(
      "Your request for pkgs.example.com was denied",
    );
    const team = await as.alice.get("/v1/team/egress");
    expect(
      team.json.domains.find((d: { domain: string }) => d.domain === "pkgs.example.com").enabled,
    ).toBe(false);
  });

  it("approval fails while the pattern is out of the ceiling (the request stays pending)", async () => {
    const req = await as.carol.post(REQUESTS, { domain: "x.files.example.com" });
    const id = req.json.request.id as string;
    expect(
      (
        await as.owner.put(`/v1/install/egress-ceiling/${enc("*.files.example.com")}`, {
          in_ceiling: false,
        })
      ).status,
    ).toBe(200);
    const res = await as.alice.post(`${TEAM_REQUESTS}/${id}`, { decision: "approve" });
    expect(res.status).toBe(409);
    expect(res.json.code).toBe("not_in_ceiling");
    const pending = await as.alice.get(TEAM_REQUESTS);
    expect(pending.json.requests.some((r: { id: string }) => r.id === id)).toBe(true);
    await as.owner.put(`/v1/install/egress-ceiling/${enc("*.files.example.com")}`, {
      in_ceiling: true,
    });
  });

  it("limits how many requests a member makes per hour", async () => {
    await h.admin.query(`DELETE FROM egress_requests WHERE requested_by = $1`, [ids.carol]);
    for (let i = 0; i < MAX_REQUESTS_PER_HOUR; i++) {
      const res = await as.carol.post(REQUESTS, { domain: `h${i}.files.example.com` });
      // Each distinct host under the wildcard names the same pattern: one pending request.
      expect([200, 201]).toContain(res.status);
      if (res.status === 201) {
        await as.alice.post(`${TEAM_REQUESTS}/${res.json.request.id}`, { decision: "deny" });
      }
    }
    const res = await as.carol.post(REQUESTS, { domain: "pkgs.example.com" });
    expect(res.status).toBe(429);
  });

  it("retries a failed email from the sweep", async () => {
    h.mailer.failNext = new Error("smtp down");
    const req = await as.bob.post(REQUESTS, { domain: "registry.npmjs.org" });
    expect(req.status).toBe(201);
    await h.mailer.settle();
    const { rows } = await h.admin.query(
      `SELECT status, attempts, last_error FROM egress_request_notifications WHERE request_id = $1`,
      [req.json.request.id],
    );
    expect(rows[0]).toMatchObject({ status: "pending", attempts: 1, last_error: "smtp_error" });
    await h.admin.query(
      `UPDATE egress_request_notifications SET next_attempt_at = now() WHERE request_id = $1`,
      [req.json.request.id],
    );
    expect(await sweepEgressRequestNotifications(h.deps)).toBe(1);
    expect(h.mailer.to("alice@req.test").at(-1)?.subject).toBe(
      "Access request: registry.npmjs.org for the Finance team",
    );
  });
});

describe("request access under concurrency (review)", () => {
  async function member(email: string): Promise<TestBrowser> {
    const id = await h.createUser(email);
    await withTeam(h.deps.database.db, finance, (tx) =>
      tx.insert(teamMembers).values({ teamId: finance, userId: id, role: "member" }),
    );
    const b = await h.signIn(email);
    expect((await b.put("/v1/me/teams/active", { teamId: finance })).status).toBe(200);
    b.team = finance;
    return b;
  }

  it("parallel requests can't pass the hourly quota (one admin email each, at most 10)", async () => {
    for (let i = 0; i < 15; i++) {
      await as.owner.post("/v1/install/egress-ceiling", { domain: `q${i}.quota.example.com` });
    }
    const erin = await member("erin@req.test");
    const before = h.mailer.to("alice@req.test").length;
    const results = await Promise.all(
      Array.from({ length: 15 }, (_, i) =>
        erin.post(REQUESTS, { domain: `q${i}.quota.example.com` }),
      ),
    );
    expect(results.filter((r) => r.status === 201)).toHaveLength(MAX_REQUESTS_PER_HOUR);
    expect(results.filter((r) => r.status === 429)).toHaveLength(15 - MAX_REQUESTS_PER_HOUR);
    await h.mailer.settle();
    expect(h.mailer.to("alice@req.test").length - before).toBe(MAX_REQUESTS_PER_HOUR);
  });

  it("parallel decisions on one pattern don't deadlock; the requests are settled once", async () => {
    await as.owner.post("/v1/install/egress-ceiling", { domain: "race.example.com" });
    const [f1, f2, f3] = [
      await member("f1@req.test"),
      await member("f2@req.test"),
      await member("f3@req.test"),
    ];
    const ids: string[] = [];
    for (const b of [f1, f2, f3]) {
      const r = await (b as TestBrowser).post(REQUESTS, { domain: "race.example.com" });
      ids.push(r.json.request.id as string);
    }
    const answers = await Promise.all(
      ids.map((id, i) =>
        as.alice.post(`${TEAM_REQUESTS}/${id}`, { decision: i === 0 ? "approve" : "deny" }),
      ),
    );
    expect(answers.filter((a) => a.status === 200)).toHaveLength(1);
    expect(answers.filter((a) => a.status === 409)).toHaveLength(2);
    const { rows } = await h.admin.query(
      `SELECT DISTINCT status FROM egress_requests WHERE team_id = $1 AND pattern = 'race.example.com'`,
      [finance],
    );
    expect(rows).toHaveLength(1);
  });

  it("enabling a domain directly settles its pending requests and tells the requesters", async () => {
    await as.owner.post("/v1/install/egress-ceiling", { domain: "direct.example.com" });
    const gina = await member("gina@req.test");
    expect((await gina.post(REQUESTS, { domain: "direct.example.com" })).status).toBe(201);
    const res = await as.alice.put("/v1/team/egress/domains/direct.example.com", {});
    expect(res.status).toBe(201);
    expect(res.json.settled_requests).toBe(1);
    await h.mailer.settle();
    expect(h.mailer.to("gina@req.test").at(-1)?.subject).toBe(
      "direct.example.com is now enabled for the Finance team",
    );
    const mine = await gina.get(`${REQUESTS}?domain=direct.example.com`);
    expect(mine.json.requests[0]).toMatchObject({ status: "approved", decided_by: ids.alice });
  });

  it("skips an email whose recipient is no longer a team admin when it is delivered", async () => {
    await as.owner.post("/v1/install/egress-ceiling", { domain: "late.example.com" });
    const hank = await member("hank@req.test");
    h.mailer.failNext = new Error("smtp down");
    const req = await hank.post(REQUESTS, { domain: "late.example.com" });
    await h.mailer.settle();
    // Alice stops being an admin before the retry (Carol becomes one so the team keeps one).
    await h.admin.query(
      `UPDATE team_members SET role = 'team_admin' WHERE team_id = $1 AND user_id = $2`,
      [finance, ids.carol],
    );
    await h.admin.query(
      `UPDATE team_members SET role = 'member' WHERE team_id = $1 AND user_id = $2`,
      [finance, ids.alice],
    );
    await h.admin.query(
      `UPDATE egress_request_notifications SET next_attempt_at = now() WHERE request_id = $1`,
      [req.json.request.id],
    );
    expect(await sweepEgressRequestNotifications(h.deps)).toBe(0);
    const { rows } = await h.admin.query(
      `SELECT status, last_error FROM egress_request_notifications WHERE request_id = $1`,
      [req.json.request.id],
    );
    expect(rows[0]).toMatchObject({ status: "skipped", last_error: "recipient_not_entitled" });
    await h.admin.query(
      `UPDATE team_members SET role = 'team_admin' WHERE team_id = $1 AND user_id = $2`,
      [finance, ids.alice],
    );
  });
});

describe("header injection", () => {
  const HEADERS = (d: string) => `/v1/team/egress/domains/${enc(d)}/headers`;

  it("is for team admins, on enabled domains only", async () => {
    const body = { headers: [{ name: "Authorization", value: "Bearer s3cr3t-value" }] };
    expect((await as.bob.put(HEADERS("pypi.org"), body)).status).toBe(403);
    expect((await as.alice.put(HEADERS("registry.npmjs.org"), body)).status).toBe(404);
  });

  it("seals the values: write-only in the API, names-only in audit, opened only with the secret", async () => {
    const value = "Bearer s3cr3t-value-0123456789";
    const res = await as.alice.put(HEADERS("pypi.org"), {
      headers: [
        { name: "Authorization", value },
        { name: "X-Org", value: "finance" },
      ],
    });
    expect(res.status, JSON.stringify(res.json)).toBe(200);
    expect(JSON.stringify(res.json)).not.toContain("s3cr3t");
    const list = await as.alice.get("/v1/team/egress");
    expect(JSON.stringify(list.json)).not.toContain("s3cr3t");
    expect(list.json.header_injection).toBe(true);
    expect(
      list.json.domains.find((d: { domain: string }) => d.domain === "pypi.org").header_names,
    ).toEqual(["Authorization", "X-Org"]);
    const { rows } = await h.admin.query(
      `SELECT header_names, headers_sealed FROM team_egress WHERE team_id = $1 AND domain = 'pypi.org'`,
      [finance],
    );
    expect(rows[0].headers_sealed).not.toContain("s3cr3t");
    expect(
      openHeaders(headerBox(HEADER_SECRET), finance, "pypi.org", rows[0].headers_sealed),
    ).toEqual([
      { name: "Authorization", value },
      { name: "X-Org", value: "finance" },
    ]);
    const set = (await audit("egress.header.set")).at(-1);
    expect(set?.target).toEqual({ domain: "pypi.org", headerNames: ["Authorization", "X-Org"] });
    const { rows: anywhere } = await h.admin.query(
      `SELECT count(*)::int AS n FROM audit_log WHERE target::text LIKE '%s3cr3t%'`,
    );
    expect(anywhere[0].n).toBe(0);
  });

  it("refuses wildcard domains and hides header names from members", async () => {
    await as.alice.put("/v1/team/egress/domains/*.files.example.com", {});
    const wild = await as.alice.put(HEADERS("*.files.example.com"), {
      headers: [{ name: "X-Key", value: "value" }],
    });
    expect(wild.status).toBe(422);
    expect(wild.json.code).toBe("wildcard_not_allowed");
    const member = await as.bob.get("/v1/team/egress");
    expect(
      member.json.domains.find((d: { domain: string }) => d.domain === "pypi.org").header_names,
    ).toEqual([]);
  });

  it("refuses reserved names, header splitting and too many headers", async () => {
    for (const headers of [
      [{ name: "Host", value: "evil.example.com" }],
      [{ name: "Proxy-Authorization", value: "x" }],
      [{ name: "X-Key", value: "a\r\nX-Evil: 1" }],
      Array.from({ length: 9 }, (_, i) => ({ name: `X-H${i}`, value: "v" })),
      [],
    ]) {
      expect((await as.alice.put(HEADERS("pypi.org"), { headers })).status).toBe(400);
    }
  });

  it("clears them (audited) and they go away with the enablement", async () => {
    expect((await as.alice.delete(HEADERS("pypi.org"))).status).toBe(204);
    expect((await audit("egress.header.cleared")).at(-1)?.target).toEqual({ domain: "pypi.org" });
    expect(
      (await as.alice.put(HEADERS("pypi.org"), { headers: [{ name: "X-Key", value: "v" }] }))
        .status,
    ).toBe(200);
    expect((await as.alice.delete("/v1/team/egress/domains/pypi.org")).status).toBe(204);
    expect((await audit("egress.domain.disabled")).at(-1)?.target).toEqual({
      domain: "pypi.org",
      headersRemoved: true,
    });
    const { rows } = await h.admin.query(
      `SELECT count(*)::int AS n FROM team_egress WHERE team_id = $1 AND domain = 'pypi.org'`,
      [finance],
    );
    expect(rows[0].n).toBe(0);
  });

  it("re-seals values sealed with a previous secret (rotation), keeping them", async () => {
    await as.alice.put("/v1/team/egress/domains/pkgs.example.com", {});
    expect(
      (
        await as.alice.put(HEADERS("pkgs.example.com"), {
          headers: [{ name: "X-Key", value: "rotate-me-1234" }],
        })
      ).status,
    ).toBe(200);
    const rotated = headerBox(["n".repeat(40), HEADER_SECRET]);
    expect(await resealTeamHeaders(h.deps.database.db, rotated)).toBe(1);
    const { rows } = await h.admin.query(
      `SELECT headers_sealed FROM team_egress WHERE team_id = $1 AND domain = 'pkgs.example.com'`,
      [finance],
    );
    expect(rotated.isCurrent(rows[0].headers_sealed)).toBe(true);
    expect(
      openHeaders(headerBox("n".repeat(40)), finance, "pkgs.example.com", rows[0].headers_sealed),
    ).toEqual([{ name: "X-Key", value: "rotate-me-1234" }]);
    expect(await resealTeamHeaders(h.deps.database.db, rotated)).toBe(0);
  });
});
