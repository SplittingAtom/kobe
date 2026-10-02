import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  EGRESS_BLOCKED_EVENT_KIND,
  EGRESS_CHANGES_CHANNEL,
  events,
  runs,
  sql,
  teamMembers,
  threads,
  withTeam,
} from "@kobe/db";
import { runWithAuditContext } from "./audit/context.js";
import { EgressBlockedRelay, relayBlockedEvents } from "./egress/blocked-relay.js";
import { createTeamWithAdmin, removeMember } from "./teams/members.js";
import { deactivateUser } from "./users/deactivation.js";
import type { TestBrowser } from "./testing/browser.js";
import { must } from "./testing/event-stream-fixture.js";
import { openHarness, type Harness } from "./testing/harness.js";

/** KOBE-38: egress ceiling and team enablement APIs, audit, change hints, egress.blocked relay. */
let h: Harness;
const ids = { owner: "", installAdmin: "", alice: "", bob: "", dave: "" };
let as: Record<keyof typeof ids, TestBrowser>;
let finance = "";
let marketing = "";

const asSystem = <T>(userId: string, fn: () => Promise<T>) =>
  runWithAuditContext({ actor: { kind: "user", id: userId }, ip: null, userAgent: null }, fn);

async function auditActions(
  prefix: string,
): Promise<{ action: string; team_id: string | null; target: Record<string, unknown> }[]> {
  const { rows } = await h.admin.query(
    `SELECT action, team_id, target FROM audit_log WHERE action LIKE $1 ORDER BY seq`,
    [`${prefix}%`],
  );
  return rows;
}

beforeAll(async () => {
  h = await openHarness();
  ids.owner = await h.createUser("owner@egress.test", "owner");
  ids.installAdmin = await h.createUser("admin@egress.test", "admin");
  ids.alice = await h.createUser("alice@egress.test");
  ids.bob = await h.createUser("bob@egress.test");
  ids.dave = await h.createUser("dave@egress.test");
  const db = h.deps.database.db;
  finance = (
    await asSystem(ids.alice, () =>
      createTeamWithAdmin(db, { slug: "finance", name: "Finance" }, ids.alice),
    )
  ).id;
  marketing = (
    await asSystem(ids.dave, () =>
      createTeamWithAdmin(db, { slug: "marketing", name: "Marketing" }, ids.dave),
    )
  ).id;
  await withTeam(db, finance, (tx) =>
    tx.insert(teamMembers).values({ teamId: finance, userId: ids.bob, role: "member" }),
  );
  as = {
    owner: await h.signIn("owner@egress.test"),
    installAdmin: await h.signIn("admin@egress.test"),
    alice: await h.signIn("alice@egress.test"),
    bob: await h.signIn("bob@egress.test"),
    dave: await h.signIn("dave@egress.test"),
  };
  for (const [who, team] of [
    ["alice", finance],
    ["bob", finance],
    ["dave", marketing],
  ] as const) {
    const res = await as[who].put("/v1/me/teams/active", { teamId: team });
    expect(res.status, JSON.stringify(res.json)).toBe(200);
    as[who].team = team;
  }
}, 120_000);
afterAll(() => h.close());

const CEILING = "/v1/install/egress-ceiling";
const enc = encodeURIComponent;

describe("install egress ceiling", () => {
  it("is for install admins only", async () => {
    expect((await as.alice.get(CEILING)).status).toBe(403);
    expect((await as.alice.post(CEILING, { domain: "x.example.com" })).status).toBe(403);
  });

  it("lists the presets: registries in the ceiling, git hosts listed but out", async () => {
    const res = await as.installAdmin.get(CEILING);
    expect(res.status).toBe(200);
    const byDomain = Object.fromEntries(
      (res.json.domains as { domain: string; preset: string; in_ceiling: boolean }[]).map((d) => [
        d.domain,
        d,
      ]),
    );
    expect(byDomain["pypi.org"]).toMatchObject({ preset: "package_registries", in_ceiling: true });
    expect(byDomain["github.com"]).toMatchObject({ preset: "git_hosts", in_ceiling: false });
    expect(res.json.presets).toEqual(["package_registries", "git_hosts", "web_search"]);
  });

  it("adds a canonicalized custom domain, refuses duplicates and junk", async () => {
    const res = await as.installAdmin.post(CEILING, {
      domain: " Data.Example.COM ",
      note: "vendor API",
    });
    expect(res.status, JSON.stringify(res.json)).toBe(201);
    expect(res.json.domain).toMatchObject({
      domain: "data.example.com",
      in_ceiling: true,
      preset: null,
      note: "vendor API",
    });
    expect((await as.installAdmin.post(CEILING, { domain: "data.example.com" })).status).toBe(409);
    for (const bad of ["10.0.0.1", "https://x.com", "a.*.com", "*.com", ""]) {
      const r = await as.installAdmin.post(CEILING, { domain: bad });
      expect(r.status, bad).toBe(400);
      expect(r.json.code).toBe("invalid_request");
    }
    expect((await as.owner.post(CEILING, { domain: "*.cdn.example.com" })).status).toBe(201);
    // Public suffixes can't be wildcarded; shared hosting is accepted with a warning.
    const suffix = await as.installAdmin.post(CEILING, { domain: "*.github.io" });
    expect(suffix.status).toBe(400);
    expect(suffix.json.message).toMatch(/public suffix/);
    const fronted = await as.installAdmin.post(CEILING, { domain: "d111.cloudfront.net" });
    expect(fronted.status).toBe(201);
    expect(fronted.json.domain.shared_hosting).toBe(true);
    expect(fronted.json.warnings[0]).toMatch(/domain fronting/);
    expect(res.json.warnings).toEqual([]);
  });

  it("puts a preset into and out of the ceiling, as a group or one domain", async () => {
    const on = await as.installAdmin.put(`${CEILING}/presets/git_hosts`, { in_ceiling: true });
    expect(on.status).toBe(200);
    const git = (on.json.domains as { domain: string; in_ceiling: boolean }[]).filter((d) =>
      ["github.com", "gitlab.com"].includes(d.domain),
    );
    expect(git.every((d) => d.in_ceiling)).toBe(true);
    const off = await as.installAdmin.put(`${CEILING}/${enc("gitlab.com")}`, { in_ceiling: false });
    expect(off.json.domain).toMatchObject({ domain: "gitlab.com", in_ceiling: false });
    expect(
      (await as.installAdmin.put(`${CEILING}/presets/nope`, { in_ceiling: true })).status,
    ).toBe(404);
    expect(
      (await as.installAdmin.put(`${CEILING}/${enc("nope.example.com")}`, { in_ceiling: true }))
        .status,
    ).toBe(404);
  });

  it("deletes custom domains (and every team's enablement) but never presets", async () => {
    expect((await as.installAdmin.delete(`${CEILING}/pypi.org`)).status).toBe(409);
    await as.installAdmin.post(CEILING, { domain: "temp.example.com" });
    expect((await as.alice.put(`/v1/team/egress/domains/temp.example.com`)).status).toBe(201);
    expect((await as.installAdmin.delete(`${CEILING}/temp.example.com`)).status).toBe(204);
    const team = await as.alice.get("/v1/team/egress");
    expect((team.json.domains as { domain: string }[]).map((d) => d.domain)).not.toContain(
      "temp.example.com",
    );
    expect((await as.installAdmin.delete(`${CEILING}/temp.example.com`)).status).toBe(404);
  });

  it("audits every ceiling change as install-level events", async () => {
    const rows = await auditActions("egress.ceiling.");
    expect(rows.map((r) => r.action)).toEqual(
      expect.arrayContaining([
        "egress.ceiling.added",
        "egress.ceiling.changed",
        "egress.ceiling.removed",
      ]),
    );
    expect(rows.every((r) => r.team_id === null)).toBe(true);
    expect(rows.find((r) => r.action === "egress.ceiling.added")?.target).toEqual({
      domain: "data.example.com",
    });
  });
});

describe("team egress", () => {
  it("fresh team: nothing enabled; members see the ceiling", async () => {
    const res = await as.bob.get("/v1/team/egress");
    expect(res.status).toBe(200);
    const pypi = (res.json.domains as { domain: string; enabled: boolean }[]).find(
      (d) => d.domain === "pypi.org",
    );
    expect(pypi).toMatchObject({ enabled: false, in_ceiling: true });
    expect((res.json.domains as { enabled: boolean }[]).some((d) => d.enabled)).toBe(false);
  });

  it("members cannot self-allow; team admins enable within the ceiling only", async () => {
    expect((await as.bob.put("/v1/team/egress/domains/pypi.org")).status).toBe(403);
    // Install admins hold no team role (D8): no active team here, so the request is refused.
    expect([400, 403]).toContain(
      (await as.installAdmin.put("/v1/team/egress/domains/pypi.org")).status,
    );
    const ok = await as.alice.put("/v1/team/egress/domains/pypi.org");
    expect(ok.status, JSON.stringify(ok.json)).toBe(201);
    expect((await as.alice.put("/v1/team/egress/domains/PYPI.org")).status).toBe(200);
    const outside = await as.alice.put(`/v1/team/egress/domains/${enc("example.org")}`);
    expect(outside.status).toBe(409);
    expect(outside.json.code).toBe("not_in_ceiling");
    expect((await as.alice.put("/v1/team/egress/domains/gitlab.com")).status).toBe(409);
  });

  it("is per team: another team sees nothing enabled", async () => {
    const mine = await as.alice.get("/v1/team/egress");
    expect(
      (mine.json.domains as { domain: string; enabled: boolean }[]).find(
        (d) => d.domain === "pypi.org",
      )?.enabled,
    ).toBe(true);
    const theirs = await as.dave.get("/v1/team/egress");
    expect((theirs.json.domains as { enabled: boolean }[]).some((d) => d.enabled)).toBe(false);
  });

  it("shows enabled domains that left the ceiling as not in it, and disables them", async () => {
    await as.installAdmin.put(`${CEILING}/pypi.org`, { in_ceiling: false });
    const res = await as.alice.get("/v1/team/egress");
    expect(
      (res.json.domains as { domain: string }[]).find((d) => d.domain === "pypi.org"),
    ).toMatchObject({
      enabled: true,
      in_ceiling: false,
    });
    await as.installAdmin.put(`${CEILING}/pypi.org`, { in_ceiling: true });
    expect((await as.alice.delete("/v1/team/egress/domains/pypi.org")).status).toBe(204);
    expect((await as.alice.delete("/v1/team/egress/domains/pypi.org")).status).toBe(404);
  });

  it("audits enablement in the team's view and notifies the proxies on commit", async () => {
    const listener = new pg.Client({
      connectionString: h.deps.database.pool.options.connectionString,
    });
    await listener.connect();
    const heard: string[] = [];
    listener.on("notification", (n) => heard.push(n.payload ?? ""));
    await listener.query(`LISTEN ${EGRESS_CHANGES_CHANNEL}`);
    await as.alice.put("/v1/team/egress/domains/registry.npmjs.org");
    await as.installAdmin.put(`${CEILING}/deb.debian.org`, { in_ceiling: false });
    await new Promise((r) => setTimeout(r, 200));
    await listener.end();
    expect(heard).toEqual([finance, "ceiling"]);
    const rows = await auditActions("egress.domain.");
    expect(rows.map((r) => [r.action, r.team_id, r.target.domain])).toEqual([
      ["egress.domain.enabled", finance, "temp.example.com"],
      ["egress.domain.enabled", finance, "pypi.org"],
      ["egress.domain.disabled", finance, "pypi.org"],
      ["egress.domain.enabled", finance, "registry.npmjs.org"],
    ]);
  });
});

async function runFor(
  teamId: string,
  userId: string,
): Promise<{ runId: string; threadId: string }> {
  return withTeam(h.deps.database.db, teamId, async (tx) => {
    const [thread] = await tx
      .insert(threads)
      .values({ teamId, ownerUserId: userId, status: "running" })
      .returning({ id: threads.id });
    const [run] = await tx
      .insert(runs)
      .values({
        teamId,
        threadId: must(thread, "thread").id,
        trigger: "user",
        status: "running",
        startedAt: new Date(),
      })
      .returning({ id: runs.id });
    return { runId: must(run, "run").id, threadId: must(thread, "thread").id };
  });
}

async function blockedEvent(teamId: string, ref: Record<string, unknown>): Promise<string> {
  return withTeam(h.deps.database.db, teamId, async (tx) => {
    const [row] = await tx
      .insert(events)
      .values({ teamId, kind: EGRESS_BLOCKED_EVENT_KIND, status: "pending", ref })
      .returning({ id: events.id });
    return must(row, "event").id;
  });
}

async function blockedRunEvents(teamId: string, runId: string) {
  const { rows } = await h.admin.query(
    `SELECT payload FROM run_events WHERE team_id = $1 AND run_id = $2 AND type = 'egress.blocked' ORDER BY seq`,
    [teamId, runId],
  );
  return rows.map((r) => r.payload);
}

describe("egress.blocked relay", () => {
  it("appends egress.blocked to the user's active run and marks the event processed", async () => {
    const { runId } = await runFor(finance, ids.bob);
    const eventId = await blockedEvent(finance, {
      sandbox_id: "4f9c2d5a-6b7e-4f90-8bc2-4d5e6f708192",
      user_id: ids.bob,
      domain: "pypi.org",
      port: 443,
      reason: "not_enabled",
      request_access: true,
    });
    expect(await relayBlockedEvents(h.deps.database.db, finance)).toBe(1);
    expect(await blockedRunEvents(finance, runId)).toEqual([
      { domain: "pypi.org", request_access: true },
    ]);
    const { rows } = await h.admin.query(`SELECT status, ref FROM events WHERE id = $1`, [eventId]);
    expect(rows[0]).toMatchObject({ status: "processed", ref: { run_ids: [runId] } });
    expect(await relayBlockedEvents(h.deps.database.db, finance)).toBe(0);
  });

  it("narrows to the hinted thread's run, and never reaches another user's runs", async () => {
    const a = await runFor(finance, ids.alice);
    const b = await runFor(finance, ids.alice);
    const other = await runFor(finance, ids.bob);
    await blockedEvent(finance, {
      user_id: ids.alice,
      domain: "example.org",
      request_access: false,
      thread_id: b.threadId,
    });
    await relayBlockedEvents(h.deps.database.db, finance);
    expect(await blockedRunEvents(finance, a.runId)).toEqual([]);
    expect(await blockedRunEvents(finance, b.runId)).toEqual([
      { domain: "example.org", request_access: false },
    ]);
    expect(await blockedRunEvents(finance, other.runId)).toEqual([]);
  });

  it("marks attempts without an active run processed, and malformed ones failed", async () => {
    const quiet = await blockedEvent(marketing, {
      user_id: ids.dave,
      domain: "pypi.org",
      request_access: true,
    });
    const bad = await blockedEvent(marketing, { domain: 42 });
    await relayBlockedEvents(h.deps.database.db, marketing);
    const { rows } = await h.admin.query(
      `SELECT id, status FROM events WHERE id = ANY($1) ORDER BY status`,
      [[quiet, bad]],
    );
    expect(Object.fromEntries(rows.map((r) => [r.id, r.status]))).toEqual({
      [quiet]: "processed",
      [bad]: "failed",
    });
  });

  it("reacts to the proxy's NOTIFY", async () => {
    const relay = new EgressBlockedRelay({
      db: h.deps.database.db,
      connectionString: h.deps.database.pool.options.connectionString ?? "",
      sweepMs: 3_600_000,
    });
    relay.start();
    await new Promise((r) => setTimeout(r, 300));
    const { runId } = await runFor(marketing, ids.dave);
    await withTeam(h.deps.database.db, marketing, async (tx) => {
      const [row] = await tx
        .insert(events)
        .values({
          teamId: marketing,
          kind: EGRESS_BLOCKED_EVENT_KIND,
          ref: { user_id: ids.dave, domain: "gitlab.com", request_access: false },
        })
        .returning({ id: events.id });
      await tx.execute(
        sql`SELECT pg_notify('kobe_egress_blocked', ${`${marketing}:${must(row, "event").id}`})`,
      );
    });
    const deadline = Date.now() + 5_000;
    while ((await blockedRunEvents(marketing, runId)).length === 0 && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 50));
    }
    await relay.close();
    expect(await blockedRunEvents(marketing, runId)).toEqual([
      { domain: "gitlab.com", request_access: false },
    ]);
  });
});

describe("user hints", () => {
  it("removing a member and deactivating a user notify the proxies (open tunnels close)", async () => {
    const listener = new pg.Client({
      connectionString: h.deps.database.pool.options.connectionString,
    });
    await listener.connect();
    const heard: string[] = [];
    listener.on("notification", (n) => heard.push(n.payload ?? ""));
    await listener.query(`LISTEN ${EGRESS_CHANGES_CHANNEL}`);
    const db = h.deps.database.db;
    expect(await asSystem(ids.alice, () => removeMember(db, finance, ids.bob))).toEqual({
      ok: true,
    });
    await asSystem(ids.installAdmin, () => deactivateUser(db, ids.dave));
    await new Promise((r) => setTimeout(r, 200));
    await listener.end();
    expect(heard).toEqual([`user:${ids.bob}`, `user:${ids.dave}`]);
  });
});
