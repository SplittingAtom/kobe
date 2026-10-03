import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { appendBackdatedAuditRow } from "@kobe/db/testing";
import { runWithAuditContext } from "./audit/context.js";
import { sweepAuditPii } from "./audit/pii-sweeper.js";
import { createTeamWithAdmin } from "./teams/members.js";
import type { TestBrowser } from "./testing/browser.js";
import { openHarness, type Harness } from "./testing/harness.js";

/**
 * KOBE-17 (user decision 2026-10-03): audit rows lose their client IP and user agent after a
 * configurable period (install setting, default 12 h, audited); the sweep records counts only,
 * legal holds suspend it, rows stay, and the chain still verifies.
 */
let h: Harness;
const ids = { owner: "", admin: "", alice: "" };
let as: Record<keyof typeof ids, TestBrowser>;
let finance = "";

async function ipOf(seq: number): Promise<string | null> {
  const { rows } = await h.admin.query<{ ip: string | null }>(
    `SELECT host(ip) AS ip FROM audit_log WHERE seq = $1`,
    [seq],
  );
  return rows[0]?.ip ?? null;
}

async function events(action: string) {
  const { rows } = await h.admin.query<{
    actor_kind: string;
    target: Record<string, unknown>;
    ip: string | null;
  }>(
    `SELECT actor_kind::text, target, host(ip) AS ip FROM audit_log WHERE action = $1 ORDER BY seq`,
    [action],
  );
  return rows;
}

beforeAll(async () => {
  h = await openHarness();
  ids.owner = await h.createUser("owner@pii.test", "owner");
  ids.admin = await h.createUser("admin@pii.test", "admin");
  ids.alice = await h.createUser("alice@pii.test");
  finance = (
    await runWithAuditContext(
      { actor: { kind: "user", id: ids.alice }, ip: null, userAgent: null },
      () =>
        createTeamWithAdmin(h.deps.database.db, { slug: "finance", name: "Finance" }, ids.alice),
    )
  ).id;
  as = {
    owner: await h.signIn("owner@pii.test"),
    admin: await h.signIn("admin@pii.test"),
    alice: await h.signIn("alice@pii.test"),
  };
}, 120_000);

afterAll(() => h?.close());

describe("the retention setting", () => {
  it("defaults to 12 hours, is bounded, and every change is audited", async () => {
    expect((await as.admin.get("/v1/install/settings")).json).toMatchObject({
      auditPiiRetentionHours: 12,
    });
    for (const bad of [0, 8761, 1.5, "24"]) {
      const res = await as.admin.put("/v1/install/settings", { auditPiiRetentionHours: bad });
      expect(res.status, String(bad)).toBe(400);
    }
    expect((await as.admin.put("/v1/install/settings", {})).status).toBe(400);
    expect(
      (await as.alice.put("/v1/install/settings", { auditPiiRetentionHours: 24 })).status,
    ).toBe(403);
    const res = await as.admin.put("/v1/install/settings", { auditPiiRetentionHours: 48 });
    expect(res.status, JSON.stringify(res.json)).toBe(200);
    expect(res.json).toMatchObject({ auditPiiRetentionHours: 48 });
    await as.admin.put("/v1/install/settings", { auditPiiRetentionHours: 12 });
    expect(
      (await events("install.settings.updated"))
        .filter((e) => e.target.setting === "audit_pii_retention_hours")
        .map((e) => e.target.value),
    ).toEqual([48, 12]);
    expect((await as.admin.get("/v1/install/settings")).json.auditPiiRetentionHours).toBe(12);
  });
});

describe("the erasure sweep (ac-4)", () => {
  it("erases rows past the period, keeps held and recent ones, records counts only (no held count: holds are confidential)", async () => {
    await sweepAuditPii(h.deps.database.db);
    const before = (await events("audit.pii_erased")).length;
    const old = await appendBackdatedAuditRow(h.admin, { hours: 13, actorId: ids.alice });
    const held = await appendBackdatedAuditRow(h.admin, {
      hours: 13,
      actorId: ids.owner,
      teamId: finance,
    });
    const recent = await appendBackdatedAuditRow(h.admin, { hours: 2, actorId: ids.alice });

    // A team-wide hold on finance keeps the team's rows.
    const hold = await as.admin.post("/v1/install/legal-hold", {
      teamId: finance,
      reason: "Litigation hold for matter 7",
    });
    const holdId = hold.json.hold.id as string;
    expect((await as.owner.post(`/v1/install/legal-hold/${holdId}/approve`)).status).toBe(200);

    const result = await sweepAuditPii(h.deps.database.db);
    expect(result).toEqual({ erased: 1, ran: true });
    expect(await ipOf(old)).toBeNull();
    expect(await ipOf(held)).not.toBeNull();
    expect(await ipOf(recent)).not.toBeNull();

    const recorded = (await events("audit.pii_erased")).slice(before);
    expect(recorded).toEqual([
      { actor_kind: "system", target: { rows: 1, olderThanHours: 12 }, ip: null },
    ]);
    // Nothing to do: nothing recorded.
    expect(await sweepAuditPii(h.deps.database.db)).toEqual({ erased: 0, ran: true });
    expect((await events("audit.pii_erased")).length).toBe(before + 1);

    // Released: the held row goes in the next run.
    await as.admin.post(`/v1/install/legal-hold/${holdId}/release`, {
      reason: "Matter closed now",
    });
    await as.owner.post(`/v1/install/legal-hold/${holdId}/release/approve`);
    expect(await sweepAuditPii(h.deps.database.db)).toEqual({ erased: 1, ran: true });
    expect(await ipOf(held)).toBeNull();
  });

  it("keeps the rows and a verifiable chain; the install log shows no IP for erased rows", async () => {
    const seq = await appendBackdatedAuditRow(h.admin, { hours: 30, actorId: ids.alice });
    await sweepAuditPii(h.deps.database.db);
    const integrity = await as.owner.get("/v1/install/audit/integrity");
    expect(integrity.status, JSON.stringify(integrity.json)).toBe(200);
    expect(integrity.json).toMatchObject({ ok: true });
    const page = await as.owner.get(`/v1/install/audit?after=${seq - 1}&limit=1`);
    expect(page.json.events[0]).toMatchObject({ seq, ip: null, userAgent: null });
  });

  it("erases many rows in one run", async () => {
    const seqs = [];
    for (let i = 0; i < 5; i++) {
      seqs.push(await appendBackdatedAuditRow(h.admin, { hours: 20, actorId: ids.alice }));
    }
    expect(await sweepAuditPii(h.deps.database.db)).toMatchObject({ erased: 5 });
    for (const seq of seqs) expect(await ipOf(seq)).toBeNull();
  });
});
