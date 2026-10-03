import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { isUnderLegalHold, sql, withTeam } from "@kobe/db";
import { runWithAuditContext } from "./audit/context.js";
import { createTeamWithAdmin } from "./teams/members.js";
import type { TestBrowser } from "./testing/browser.js";
import { openHarness, type Harness } from "./testing/harness.js";

/**
 * KOBE-17 legal hold end to end: request, two-person placement and release (D18 → D10 rule),
 * single-admin self-approval (flagged), audit of every change (install scope, no subject id or
 * reason), invisibility to the held user, and purges refused while held (ac-1).
 */
let h: Harness;
const ids = { owner: "", admin: "", heldAdmin: "", alice: "", bob: "" };
let as: Record<keyof typeof ids, TestBrowser>;
let finance = "";

const BASE = "/v1/install/legal-hold";
const REASON = "Litigation hold for matter 2026-17";

async function auditFor(holdId: string) {
  const { rows } = await h.admin.query<{
    action: string;
    team_id: string | null;
    actor_id: string | null;
    target: Record<string, unknown>;
    ip: string | null;
  }>(
    `SELECT action, team_id, actor_id, target, host(ip) AS ip FROM audit_log
     WHERE target->>'holdId' = $1 ORDER BY seq`,
    [holdId],
  );
  return rows;
}

async function requestHold(
  body: Record<string, unknown> = {},
  by: keyof typeof ids = "admin",
): Promise<string> {
  const res = await as[by].post(BASE, { teamId: finance, reason: REASON, ...body });
  expect(res.status, JSON.stringify(res.json)).toBe(201);
  return res.json.hold.id as string;
}

async function placed(body: Record<string, unknown> = {}): Promise<string> {
  const id = await requestHold(body);
  const res = await as.owner.post(`${BASE}/${id}/approve`);
  expect(res.status, JSON.stringify(res.json)).toBe(200);
  return id;
}

async function released(id: string): Promise<void> {
  expect(
    (await as.admin.post(`${BASE}/${id}/release`, { reason: "Matter settled in full" })).status,
  ).toBe(200);
  expect((await as.owner.post(`${BASE}/${id}/release/approve`)).status).toBe(200);
}

beforeAll(async () => {
  h = await openHarness();
  ids.owner = await h.createUser("owner@lh.test", "owner");
  ids.admin = await h.createUser("admin@lh.test", "admin");
  ids.heldAdmin = await h.createUser("held@lh.test", "admin");
  ids.alice = await h.createUser("alice@lh.test");
  ids.bob = await h.createUser("bob@lh.test");
  finance = (
    await runWithAuditContext(
      { actor: { kind: "user", id: ids.alice }, ip: null, userAgent: null },
      () =>
        createTeamWithAdmin(h.deps.database.db, { slug: "finance", name: "Finance" }, ids.alice),
    )
  ).id;
  as = {
    owner: await h.signIn("owner@lh.test"),
    admin: await h.signIn("admin@lh.test"),
    heldAdmin: await h.signIn("held@lh.test"),
    alice: await h.signIn("alice@lh.test"),
    bob: await h.signIn("bob@lh.test"),
  };
  const res = await as.alice.put("/v1/me/teams/active", { teamId: finance });
  expect(res.status).toBe(200);
  as.alice.team = finance;
}, 120_000);

afterAll(() => h?.close());

describe("access", () => {
  it("is for install admins only", async () => {
    for (const [method, path] of [
      ["GET", BASE],
      ["POST", BASE],
      ["POST", `${BASE}/00000000-0000-4000-8000-000000000000/approve`],
    ] as const) {
      const res = await as.alice.request(method, path, method === "POST" ? {} : undefined);
      expect(res.status, `${method} ${path}`).toBe(403);
    }
  });

  it("validates requests", async () => {
    expect((await as.admin.post(BASE, { teamId: finance, reason: "short" })).status).toBe(400);
    expect((await as.admin.post(BASE, { teamId: finance, reason: REASON, extra: 1 })).status).toBe(
      400,
    );
    const unknownTeam = await as.admin.post(BASE, {
      teamId: "00000000-0000-4000-8000-000000000000",
      reason: REASON,
    });
    expect(unknownTeam.json.code).toBe("team_not_found");
    const unknownUser = await as.admin.post(BASE, {
      teamId: finance,
      userId: "00000000-0000-4000-8000-000000000000",
      reason: REASON,
    });
    expect(unknownUser.json.code).toBe("user_not_found");
    const self = await as.admin.post(BASE, { teamId: finance, userId: ids.admin, reason: REASON });
    expect(self.json.code).toBe("subject_is_requester");
  });
});

describe("placing a hold (ac-2, ac-3)", () => {
  it("records a pending request, then a second admin places it; both audited without subject or reason", async () => {
    const id = await requestHold({ userId: ids.bob });
    const pending = await as.admin.get(`${BASE}/${id}`);
    expect(pending.json.hold).toMatchObject({
      status: "pending",
      scope: "user",
      subject: { id: ids.bob },
      reason: REASON,
      actions: { approve: false, deny: false, withdraw: true },
    });
    expect(await isUnderLegalHold(h.deps.database.db, finance, ids.bob)).toBe(false);

    const own = await as.admin.post(`${BASE}/${id}/approve`);
    expect(own.status).toBe(403);
    expect(own.json.code).toBe("self_approval_forbidden");

    const ok = await as.owner.post(`${BASE}/${id}/approve`);
    expect(ok.status, JSON.stringify(ok.json)).toBe(200);
    expect(ok.json.hold).toMatchObject({
      status: "active",
      approvedBy: { id: ids.owner },
      selfApproved: false,
    });
    expect(await isUnderLegalHold(h.deps.database.db, finance, ids.bob)).toBe(true);

    const events = await auditFor(id);
    expect(events.map((e) => [e.action, e.actor_id, e.team_id])).toEqual([
      ["governance.legal_hold.requested", ids.admin, null],
      ["governance.legal_hold.placed", ids.owner, null],
    ]);
    expect(events[0]?.target).toEqual({ holdId: id, teamId: finance, scope: "user" });
    expect(events[1]?.target).toEqual({
      holdId: id,
      teamId: finance,
      scope: "user",
      selfApproved: false,
    });
    expect(JSON.stringify(events)).not.toContain(ids.bob);
    expect(JSON.stringify(events)).not.toContain("matter 2026-17");
    expect(events[0]?.ip).toBe(as.admin.ip);
    await released(id);
  });

  it("is denied by another admin, or withdrawn by its requester", async () => {
    const denied = await requestHold();
    expect((await as.admin.post(`${BASE}/${denied}/deny`)).json.code).toBe("cannot_deny_own");
    const deny = await as.owner.post(`${BASE}/${denied}/deny`);
    expect(deny.json.hold).toMatchObject({ status: "denied", closedBy: { id: ids.owner } });
    expect((await as.owner.post(`${BASE}/${denied}/approve`)).json.code).toBe("not_pending");

    const withdrawn = await requestHold();
    expect((await as.owner.post(`${BASE}/${withdrawn}/withdraw`)).json.code).toBe("not_requester");
    expect((await as.admin.post(`${BASE}/${withdrawn}/withdraw`)).json.hold.status).toBe(
      "withdrawn",
    );
    expect((await auditFor(denied)).map((e) => e.action)).toEqual([
      "governance.legal_hold.requested",
      "governance.legal_hold.denied",
    ]);
    expect((await auditFor(withdrawn)).map((e) => e.action)).toEqual([
      "governance.legal_hold.requested",
      "governance.legal_hold.withdrawn",
    ]);
  });

  it("lets a single-admin install self-approve placing and releasing, flagged (D10)", async () => {
    const { rows } = await h.admin.query<{ user_id: string; role: string }>(
      `DELETE FROM install_roles WHERE user_id <> $1 RETURNING user_id, role::text`,
      [ids.owner],
    );
    try {
      const id = await requestHold({}, "owner");
      const list = await as.owner.get(BASE);
      expect(list.json.selfApprovalAllowed).toBe(true);
      const ok = await as.owner.post(`${BASE}/${id}/approve`);
      expect(ok.json.hold).toMatchObject({ status: "active", selfApproved: true });
      await as.owner.post(`${BASE}/${id}/release`, { reason: "Matter settled in full" });
      const done = await as.owner.post(`${BASE}/${id}/release/approve`);
      expect(done.json.hold).toMatchObject({ status: "released", releaseSelfApproved: true });
      const events = await auditFor(id);
      expect(events.find((e) => e.action === "governance.legal_hold.placed")?.target).toMatchObject(
        { selfApproved: true },
      );
      expect(
        events.find((e) => e.action === "governance.legal_hold.released")?.target,
      ).toMatchObject({ selfApproved: true });
    } finally {
      for (const r of rows) {
        await h.admin.query(`INSERT INTO install_roles (user_id, role) VALUES ($1, $2)`, [
          r.user_id,
          r.role,
        ]);
      }
    }
  });
});

describe("releasing a hold (ac-2, ac-3)", () => {
  it("needs a second install admin; the hold stays in force meanwhile", async () => {
    const id = await placed();
    const ask = await as.admin.post(`${BASE}/${id}/release`, { reason: "Matter settled in full" });
    expect(ask.json.hold).toMatchObject({
      status: "active",
      release: { requestedBy: { id: ids.admin }, reason: "Matter settled in full" },
      actions: { approveRelease: false, withdrawRelease: true },
    });
    expect(
      (await as.admin.post(`${BASE}/${id}/release`, { reason: "again, twice over" })).json.code,
    ).toBe("release_pending");
    expect((await as.admin.post(`${BASE}/${id}/release/approve`)).json.code).toBe(
      "release_self_approval_forbidden",
    );
    expect(await isUnderLegalHold(h.deps.database.db, finance)).toBe(true);
    const done = await as.owner.post(`${BASE}/${id}/release/approve`);
    expect(done.json.hold).toMatchObject({
      status: "released",
      releasedBy: { id: ids.owner },
      releaseSelfApproved: false,
    });
    expect((await auditFor(id)).map((e) => [e.action, e.actor_id])).toEqual([
      ["governance.legal_hold.requested", ids.admin],
      ["governance.legal_hold.placed", ids.owner],
      ["governance.legal_hold.release_requested", ids.admin],
      ["governance.legal_hold.released", ids.owner],
    ]);
  });

  it("can be denied by another admin or withdrawn by its requester", async () => {
    const id = await placed();
    await as.admin.post(`${BASE}/${id}/release`, { reason: "Matter settled in full" });
    expect((await as.admin.post(`${BASE}/${id}/release/deny`)).json.code).toBe(
      "cannot_deny_own_release",
    );
    expect((await as.owner.post(`${BASE}/${id}/release/withdraw`)).json.code).toBe(
      "not_release_requester",
    );
    const denied = await as.owner.post(`${BASE}/${id}/release/deny`);
    expect(denied.json.hold).toMatchObject({ status: "active", release: null });
    await as.owner.post(`${BASE}/${id}/release`, { reason: "Second try, settled" });
    expect((await as.owner.post(`${BASE}/${id}/release/withdraw`)).json.hold.release).toBeNull();
    expect((await auditFor(id)).map((e) => e.action).slice(2)).toEqual([
      "governance.legal_hold.release_requested",
      "governance.legal_hold.release_denied",
      "governance.legal_hold.release_requested",
      "governance.legal_hold.release_withdrawn",
    ]);
    await released(id);
  });
});

describe("confidentiality", () => {
  it("hides a hold from the held install admin, and from the team's audit view", async () => {
    const id = await requestHold({ userId: ids.heldAdmin });
    const list = await as.heldAdmin.get(BASE);
    expect(list.json.holds.map((x: { id: string }) => x.id)).not.toContain(id);
    expect((await as.heldAdmin.get(`${BASE}/${id}`)).status).toBe(404);
    expect((await as.heldAdmin.post(`${BASE}/${id}/approve`)).status).toBe(404);
    expect((await as.heldAdmin.post(`${BASE}/${id}/deny`)).status).toBe(404);
    await as.owner.post(`${BASE}/${id}/approve`);
    expect(
      (await as.heldAdmin.post(`${BASE}/${id}/release`, { reason: "Not my hold, release" })).status,
    ).toBe(404);

    const team = await as.alice.get("/v1/team/audit?category=governance");
    expect(team.status).toBe(200);
    expect(
      team.json.events.filter((e: { action: string }) =>
        e.action.startsWith("governance.legal_hold"),
      ),
    ).toEqual([]);
    await released(id);
  });
});

describe("held data survives purges (ac-1)", () => {
  it("refuses to delete the held team's threads until the hold is released", async () => {
    const thread = await as.alice.post("/v1/threads", { title: "evidence" });
    expect(thread.status, JSON.stringify(thread.json)).toBe(201);
    const threadId = thread.json.thread_id as string;
    const id = await placed();
    const purge = () =>
      withTeam(h.deps.database.db, finance, (tx) =>
        tx.execute(sql`DELETE FROM threads WHERE team_id = ${finance} AND id = ${threadId}`),
      );
    await expect(purge()).rejects.toMatchObject({ cause: { code: "KH001" } });
    // Trash (soft delete) is not a purge.
    expect((await as.alice.request("DELETE", `/v1/threads/${threadId}`)).status).toBeLessThan(300);
    await released(id);
    await purge();
  });
});
