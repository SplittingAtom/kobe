import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadEnvelope } from "@kobe/db";
import { driftNoticesFor } from "./connectors/drift-recipients.js";
import { notifyDrift } from "./connectors/drift-notify.js";
import type { ProbeResult } from "./connectors/probe.js";
import { refreshAllConnectors, refreshConnector } from "./connectors/refresh.js";
import type { TestBrowser } from "./testing/browser.js";
import { openHarness, type Harness } from "./testing/harness.js";

/**
 * KOBE-431 (decision (a), 2026-10-19): the periodic refresh of a connector that needs a credential
 * probes with the own key of the site admin who last pinned or re-approved it, never a member's;
 * the choice is audited without the value; with no usable admin key the refresh is skipped as
 * auth_required, and site admins see that on the connector page, in their notices and by email.
 */
const must = <T>(v: T | undefined): T => {
  if (v === undefined) throw new Error("expected a value");
  return v;
};
const BASE = "/v1/site/connectors";
const ADMIN_KEY = "admin-key-0123456789abcdef";
const OTHER_ADMIN_KEY = "other-admin-key-0123456789";
const MEMBER_KEY = "member-key-0123456789abcdef";
const team = randomUUID();
let h: Harness;
let root: TestBrowser;
let other: TestBrowser;
let alice: TestBrowser;
let rootId = "";
let otherId = "";
/** The keys each probe was sent (undefined: none). */
const probedKeys: (string | undefined)[] = [];
let tools = [{ name: "a", description: "d", inputSchema: { type: "object" } }];
const quiet = { info: () => undefined, warn: () => undefined };

/** A server that, like Catalyst's Go /mcp, answers only an admin's key. */
const answer = (key: string | undefined): ProbeResult =>
  key === ADMIN_KEY || key === OTHER_ADMIN_KEY
    ? { ok: true, tools }
    : { ok: false, failure: "auth_required" };

beforeAll(async () => {
  h = await openHarness({
    envelope: must(loadEnvelope({ KOBE_ENVELOPE_KEY: "e".repeat(48) })),
    connectors: { resolve: async () => ["93.184.216.34"] },
    connectorProbe: {
      probe: async (_url, apiKey) => {
        probedKeys.push(apiKey);
        return answer(apiKey);
      },
    },
  });
  rootId = await h.createUser("root@probe.test", "admin");
  otherId = await h.createUser("other@probe.test", "admin");
  const aliceId = await h.createUser("alice@probe.test");
  await h.admin.query(`INSERT INTO teams (id, slug, name) VALUES ($1, 'p', 'p')`, [team]);
  for (const [user, role] of [
    [rootId, "team_admin"],
    [otherId, "member"],
    [aliceId, "member"],
  ] as const) {
    await h.admin.query(`INSERT INTO team_members (team_id, user_id, role) VALUES ($1, $2, $3)`, [
      team,
      user,
      role,
    ]);
  }
  root = await h.signIn("root@probe.test");
  other = await h.signIn("other@probe.test");
  alice = await h.signIn("alice@probe.test");
  for (const b of [root, other, alice]) {
    await b.put("/v1/me/teams/active", { teamId: team });
    b.team = team;
  }
});
afterAll(async () => {
  await h?.close();
});

const db = () => h.deps.database.db;
const refresh = (id: string) =>
  refreshConnector(db(), h.deps.connectorProbe, id, { envelope: h.deps.envelope });
const enable = (connectorId: string) =>
  h.admin.query(
    `INSERT INTO team_connectors (team_id, connector_id, exposure, enabled_by) VALUES ($1, $2, 'all', $3)`,
    [team, connectorId, rootId],
  );
const saveKey = (who: TestBrowser, connectorId: string, key: string) =>
  who.put(`/v1/connector-grants/${connectorId}`, { api_key: key });
const row = async (id: string) =>
  (
    await h.admin.query(
      `SELECT pinned_by, refresh_skipped, refreshed_at, tools_snapshot FROM connectors WHERE id = $1`,
      [id],
    )
  ).rows[0] as {
    pinned_by: string | null;
    refresh_skipped: string | null;
    refreshed_at: Date | null;
    tools_snapshot: { name: string; status: string }[];
  };
const events = async (action: string, connectorId: string) =>
  (
    await h.admin.query<{ actor_kind: string; actor_id: string | null; target: object }>(
      `SELECT actor_kind, actor_id, target FROM audit_log
        WHERE action = $1 AND target->>'connectorId' = $2 ORDER BY seq`,
      [action, connectorId],
    )
  ).rows;

/** An api_key connector, enabled for the team, pinned by root with root's own key. */
async function pinnedByRoot(name: string): Promise<string> {
  tools = [{ name: "a", description: "d", inputSchema: { type: "object" } }];
  const created = await root.post(BASE, {
    name,
    url: `https://${name}.example/mcp`,
    authKind: "api_key",
  });
  const id = created.json.connector.id as string;
  // The registration probe has no key yet: unpinned, like Catalyst after its re-add.
  expect(created.json.pin).toMatchObject({ ok: false, failure: "auth_required" });
  await enable(id);
  expect((await saveKey(root, id, ADMIN_KEY)).status).toBe(201);
  const pinned = await root.post(`${BASE}/${id}/pin`);
  expect(pinned.json.pin).toEqual({ ok: true, tools: 1 });
  return id;
}

describe("pinning records the admin and the credential", () => {
  it("sets pinned_by to the acting admin and audits the choice without the key", async () => {
    const id = await pinnedByRoot("pin-a");
    expect((await row(id)).pinned_by).toBe(rootId);
    const choices = await events("mcp.connector.probe_credential", id);
    expect(choices.map((e) => e.target)).toEqual([
      { connectorId: id, name: "pin-a", purpose: "pin", credential: "none" },
      { connectorId: id, name: "pin-a", purpose: "pin", credential: "admin_key", adminId: rootId },
    ]);
    expect(choices.every((e) => e.actor_id === rootId)).toBe(true);
    const text = JSON.stringify(await h.admin.query(`SELECT target FROM audit_log`));
    expect(text).not.toContain(ADMIN_KEY);
  });
});

describe("the periodic refresh of an auth-required connector (ac-1, ac-2)", () => {
  it("probes with the pinning admin's key and finds new tools as drifted", async () => {
    const id = await pinnedByRoot("refresh-a");
    // A member's key exists too: it is never used.
    expect((await saveKey(alice, id, MEMBER_KEY)).status).toBe(201);
    tools = [...tools, { name: "fresh", description: "new", inputSchema: { type: "object" } }];
    probedKeys.length = 0;
    expect(await refresh(id)).toEqual({
      status: "drifted",
      changed: 0,
      added: 1,
      removed: 0,
      templates: { changed: 0, added: 0, removed: 0, invalid: 0 },
    });
    expect(probedKeys).toEqual([ADMIN_KEY]);
    const r = await row(id);
    expect(r.tools_snapshot.map((t) => [t.name, t.status])).toEqual([
      ["a", "pinned"],
      ["fresh", "drifted"],
    ]);
    expect(r.refresh_skipped).toBeNull();
    expect(r.refreshed_at).not.toBeNull();

    const choice = await events("mcp.connector.probe_credential", id);
    expect(choice.at(-1)).toMatchObject({
      actor_kind: "system",
      target: { purpose: "refresh", credential: "admin_key", adminId: rootId },
    });
    // The same choice next pass is not audited again.
    await refresh(id);
    expect((await events("mcp.connector.probe_credential", id)).length).toBe(choice.length);
  });

  it("never falls back to a member's key: no usable admin key skips as auth_required (ac-2, ac-3)", async () => {
    const id = await pinnedByRoot("refresh-b");
    expect((await saveKey(alice, id, MEMBER_KEY)).status).toBe(201);
    await root.delete(`/v1/connector-grants/${id}`);
    probedKeys.length = 0;
    expect(await refresh(id)).toEqual({ status: "skipped", reason: "auth_required" });
    expect(probedKeys).toEqual([undefined]);
    expect((await row(id)).refresh_skipped).toBe("auth_required");
    expect((await events("mcp.connector.probe_credential", id)).at(-1)?.target).toEqual({
      connectorId: id,
      name: "refresh-b",
      purpose: "refresh",
      credential: "none",
    });
    const skips = await events("mcp.connector.refresh_skipped", id);
    expect(skips).toHaveLength(1);
    expect(skips[0]).toMatchObject({
      actor_kind: "system",
      target: { name: "refresh-b", reason: "auth_required" },
    });
    // Skipping again is not a new event.
    await refresh(id);
    expect(await events("mcp.connector.refresh_skipped", id)).toHaveLength(1);

    // The connector page shows it.
    const view = (await root.get(`${BASE}/${id}`)).json.connector;
    expect(view).toMatchObject({ refreshSkipped: "auth_required" });
    expect(view.refreshedAt).toEqual(expect.any(String));

    // The admin saves a key again: the next pass clears the skip.
    await saveKey(root, id, ADMIN_KEY);
    expect(await refresh(id)).toEqual({ status: "unchanged" });
    expect((await row(id)).refresh_skipped).toBeNull();
    expect((await root.get(`${BASE}/${id}`)).json.connector.refreshSkipped).toBeNull();
  });

  it("does not use the key of an admin who was deactivated or is no longer a site admin", async () => {
    const id = await pinnedByRoot("refresh-c");
    await h.admin.query(`UPDATE connectors SET pinned_by = $1 WHERE id = $2`, [otherId, id]);
    expect((await saveKey(other, id, OTHER_ADMIN_KEY)).status).toBe(201);
    probedKeys.length = 0;
    expect(await refresh(id)).toEqual({ status: "unchanged" });
    expect(probedKeys).toEqual([OTHER_ADMIN_KEY]);

    await h.admin.query(`DELETE FROM site_roles WHERE user_id = $1`, [otherId]);
    probedKeys.length = 0;
    expect(await refresh(id)).toEqual({ status: "skipped", reason: "auth_required" });
    expect(probedKeys).toEqual([undefined]);

    await h.admin.query(`INSERT INTO site_roles (user_id, role) VALUES ($1, 'admin')`, [otherId]);
    await h.admin.query(`UPDATE users SET deactivated_at = now() WHERE id = $1`, [otherId]);
    probedKeys.length = 0;
    expect(await refresh(id)).toEqual({ status: "skipped", reason: "auth_required" });
    expect(probedKeys).toEqual([undefined]);
    await h.admin.query(`UPDATE users SET deactivated_at = NULL WHERE id = $1`, [otherId]);
  });

  /** Adds a drifted tool and has `who` approve it. */
  async function approveNew(id: string, who: TestBrowser, tool: string, before?: () => unknown) {
    tools = [...tools, { name: tool, description: "new", inputSchema: { type: "object" } }];
    await refresh(id);
    await before?.();
    const review = (await who.get(`${BASE}/${id}/tools`)).json.tools as {
      name: string;
      live?: { sha256: string };
    }[];
    const pending = must(review.find((t) => t.name === tool));
    const ok = await who.post(`${BASE}/${id}/tools/approve`, {
      tools: [{ name: tool, sha256: must(pending.live).sha256 }],
    });
    expect(ok.status).toBe(200);
  }

  it("a keyless approver leaves a keyed pinned_by in place (review M1)", async () => {
    const id = await pinnedByRoot("refresh-d");
    await approveNew(id, other, "b");
    expect((await row(id)).pinned_by).toBe(rootId);
    probedKeys.length = 0;
    await refresh(id);
    expect(probedKeys).toEqual([ADMIN_KEY]);
  });

  it("an approver with a usable key takes over pinned_by", async () => {
    const id = await pinnedByRoot("refresh-d2");
    expect((await saveKey(other, id, OTHER_ADMIN_KEY)).status).toBe(201);
    await approveNew(id, other, "b");
    expect((await row(id)).pinned_by).toBe(otherId);
  });

  it("a keyless approver takes over when the admin named has no usable key either", async () => {
    const id = await pinnedByRoot("refresh-d3");
    await approveNew(id, other, "b", () => root.delete(`/v1/connector-grants/${id}`));
    expect((await row(id)).pinned_by).toBe(otherId);
  });

  it("audits the refresh's choice only when it changes: admin_key, none, admin_key (review test 6)", async () => {
    const id = await pinnedByRoot("refresh-audit");
    const refreshChoices = async () =>
      (await events("mcp.connector.probe_credential", id))
        .map((e) => e.target as { purpose: string; credential: string })
        .filter((t) => t.purpose === "refresh")
        .map((t) => t.credential);
    await refresh(id);
    await refresh(id);
    expect(await refreshChoices()).toEqual(["admin_key"]);
    await root.delete(`/v1/connector-grants/${id}`);
    await refresh(id);
    await refresh(id);
    expect(await refreshChoices()).toEqual(["admin_key", "none"]);
    await saveKey(root, id, ADMIN_KEY);
    await refresh(id);
    await refresh(id);
    expect(await refreshChoices()).toEqual(["admin_key", "none", "admin_key"]);
  });

  it("a connector without auth probes with no key and no lookup", async () => {
    tools = [{ name: "a", description: "d", inputSchema: { type: "object" } }];
    const open = { probe: async () => ({ ok: true as const, tools }) };
    const created = await root.post(BASE, {
      name: "refresh-open",
      url: "https://refresh-open.example/mcp",
      authKind: "none",
    });
    const id = created.json.connector.id as string;
    // The registration probe above went through the auth-checking fake: pin it directly.
    await h.admin.query(
      `UPDATE connectors SET tools_snapshot = $1::jsonb, tools_hash = $2 WHERE id = $3`,
      [JSON.stringify([]), "0".repeat(64), id],
    );
    const outcome = await refreshConnector(db(), open, id, { envelope: h.deps.envelope });
    expect(outcome.status).toBe("drifted");
    expect((await events("mcp.connector.probe_credential", id)).at(-1)?.target).toMatchObject({
      purpose: "refresh",
      credential: "none",
    });
  });
});

describe("site admins are told about an auth_required skip (ac-3)", () => {
  it("emails site admins once and lists it in their connector notices, not members'", async () => {
    const id = await pinnedByRoot("notify-a");
    await root.delete(`/v1/connector-grants/${id}`);
    await refreshAllConnectors(db(), h.deps.connectorProbe, quiet, { envelope: h.deps.envelope });
    expect((await row(id)).refresh_skipped).toBe("auth_required");

    const sweep = () => notifyDrift({ db: db(), mailer: h.mailer, publicUrl: "https://kobe.test" });
    await sweep();
    const mail = h.mailer.to("root@probe.test").filter((m) => m.subject.includes("notify-a"));
    expect(mail).toHaveLength(1);
    expect(must(mail[0]).subject).toMatch(/not checked for changes/);
    expect(must(mail[0]).text).not.toContain(ADMIN_KEY);
    expect(h.mailer.to("alice@probe.test").filter((m) => m.subject.includes("notify-a"))).toEqual(
      [],
    );
    await sweep();
    expect(
      h.mailer.to("root@probe.test").filter((m) => m.subject.includes("notify-a")),
    ).toHaveLength(1);

    const forAdmin = await driftNoticesFor(db(), { id: rootId, siteRole: "admin" });
    expect(forAdmin.find((n) => n.connectorId === id)).toEqual({
      connectorId: id,
      name: "notify-a",
      tools: [],
      templates: [],
      invalidTemplates: [],
      refreshSkipped: "auth_required",
    });
    const aliceNotices = (await alice.get("/v1/me/connector-notices")).json.notices as {
      connectorId: string;
    }[];
    expect(aliceNotices.some((n) => n.connectorId === id)).toBe(false);

    // The skip email does not hold back a drift email for the same connector (review L3).
    await saveKey(root, id, ADMIN_KEY);
    tools = [...tools, { name: "later", description: "new", inputSchema: { type: "object" } }];
    expect((await refresh(id)).status).toBe("drifted");
    await sweep();
    const drift = h.mailer
      .to("root@probe.test")
      .filter((m) => m.subject === "Connector notify-a: tools changed and are disabled");
    expect(drift).toHaveLength(1);
  });

  it("tells admins of a site-key connector to set the site key, not to add their own (review L2)", async () => {
    const created = await root.post(BASE, {
      name: "notify-site",
      url: "https://notify-site.example/mcp",
      authKind: "api_key",
      credentialSource: "site",
    });
    expect(created.json.pin.message).toMatch(/site-wide key/);
    expect(created.json.pin.message).not.toMatch(/My connector keys/);
    const id = created.json.connector.id as string;
    await h.admin.query(`UPDATE connectors SET tools_hash = $1 WHERE id = $2`, [
      "0".repeat(64),
      id,
    ]);
    await refresh(id);
    await notifyDrift({ db: db(), mailer: h.mailer, publicUrl: "https://kobe.test" });
    const mail = h.mailer.to("root@probe.test").filter((m) => m.subject.includes("notify-site"));
    expect(mail).toHaveLength(1);
    expect(must(mail[0]).text).toMatch(/Set \(or re-enter\) its site-wide key/);
    expect(must(mail[0]).text).not.toMatch(/My connector keys/);
  });
});
