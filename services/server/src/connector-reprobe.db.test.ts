import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadEnvelope } from "@kobe/db";
import type { ProbeResult } from "./connectors/probe.js";
import {
  connectorRefreshLockName,
  connectorRefreshLocks,
  refreshAllConnectors,
} from "./connectors/refresh.js";
import type { TestBrowser } from "./testing/browser.js";
import { openHarness, type Harness } from "./testing/harness.js";

/**
 * KOBE-430: the Re-probe button (`POST /v1/site/connectors/:id/refresh`) runs the periodic
 * refresh's probe and drift for one connector now: site admins only, rate-limited, audited with
 * counts only, never overlapping the periodic pass for that connector, and an admin edit during
 * the probe wins. D27 / U7 keep holding: changed and new tools stay disabled until re-approved.
 */
const must = <T>(v: T | undefined): T => {
  if (v === undefined) throw new Error("expected a value");
  return v;
};
const BASE = "/v1/site/connectors";
const ADMIN_KEY = "admin-key-0123456789abcdef";
const team = randomUUID();
let h: Harness;
let root: TestBrowser;
let other: TestBrowser;
let alice: TestBrowser;
let rootId = "";

type Tool = { name: string; description: string; inputSchema: Record<string, unknown> };
const tool = (name: string, description = "d"): Tool => ({
  name,
  description,
  inputSchema: { type: "object" },
});
/** The live tools per server URL; a URL missing here is unreachable. */
const live = new Map<string, Tool[]>();
/** Runs during a probe (e.g. an admin edit), then is cleared. */
let duringProbe: (() => Promise<void>) | undefined;
const keysSent: (string | undefined)[] = [];

const answer = async (url: string, key: string | undefined): Promise<ProbeResult> => {
  keysSent.push(key);
  const hook = duringProbe;
  duringProbe = undefined;
  await hook?.();
  if (url.includes("keyed") && key !== ADMIN_KEY) return { ok: false, failure: "auth_required" };
  const tools = live.get(url);
  return tools ? { ok: true, tools } : { ok: false, failure: "unreachable" };
};

beforeAll(async () => {
  h = await openHarness({
    envelope: must(loadEnvelope({ KOBE_ENVELOPE_KEY: "e".repeat(48) })),
    connectors: { resolve: async () => ["93.184.216.34"] },
    connectorProbe: { probe: (url, key) => answer(url, key) },
  });
  rootId = await h.createUser("root@reprobe.test", "admin");
  await h.createUser("other@reprobe.test", "admin");
  const aliceId = await h.createUser("alice@reprobe.test");
  await h.admin.query(`INSERT INTO teams (id, slug, name) VALUES ($1, 'rp', 'rp')`, [team]);
  await h.admin.query(
    `INSERT INTO team_members (team_id, user_id, role) VALUES ($1, $2, 'team_admin'), ($1, $3, 'member')`,
    [team, rootId, aliceId],
  );
  root = await h.signIn("root@reprobe.test");
  other = await h.signIn("other@reprobe.test");
  alice = await h.signIn("alice@reprobe.test");
  for (const b of [root, alice]) {
    await b.put("/v1/me/teams/active", { teamId: team });
    b.team = team;
  }
});
afterAll(async () => {
  await h?.close();
});

const urlOf = (name: string) => `https://${name}.example/mcp`;

/** Registers a no-auth connector whose server lists `tools` (pinned at registration). */
async function registered(name: string, tools: Tool[] = [tool("a"), tool("c")]): Promise<string> {
  live.set(urlOf(name), tools);
  const created = await root.post(BASE, { name, url: urlOf(name), authKind: "none" });
  expect(created.status).toBe(201);
  return created.json.connector.id as string;
}

const reprobe = (id: string, who: TestBrowser = root) => who.post(`${BASE}/${id}/refresh`);
const snapshot = async (id: string) =>
  (
    await h.admin.query<{ tools_snapshot: { name: string; status: string }[] }>(
      `SELECT tools_snapshot FROM connectors WHERE id = $1`,
      [id],
    )
  ).rows[0]?.tools_snapshot ?? [];
const events = async (action: string, connectorId: string) =>
  (
    await h.admin.query<{ actor_kind: string; actor_id: string | null; target: object }>(
      `SELECT actor_kind, actor_id, target FROM audit_log
        WHERE action = $1 AND target->>'connectorId' = $2 ORDER BY seq`,
      [action, connectorId],
    )
  ).rows;

describe("who may re-probe", () => {
  it("refuses members (server-enforced) and unknown connectors", async () => {
    const id = await registered("rp-authz");
    expect((await reprobe(id, alice)).status).toBe(403);
    expect((await reprobe(randomUUID())).status).toBe(404);
    expect((await reprobe("not-a-uuid")).status).toBe(404);
    expect(await events("mcp.connector.refreshed", id)).toEqual([]);
  });
});

describe("outcomes", () => {
  it("says unchanged and audits the counts", async () => {
    const id = await registered("rp-same");
    const res = await reprobe(id);
    expect(res.status).toBe(200);
    expect(res.json.refresh).toMatchObject({ status: "unchanged" });
    expect(res.json.refresh.message).toMatch(/no changes/i);
    expect(res.json.connector.id).toBe(id);
    const audit = await events("mcp.connector.refreshed", id);
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({ actor_kind: "user", actor_id: rootId });
    expect(audit[0]?.target).toEqual({
      connectorId: id,
      name: "rp-same",
      outcome: "unchanged",
      changed: 0,
      added: 0,
      removed: 0,
      credential: "none",
    });
  });

  it("applies D27 drift: changed and new tools disabled until re-approved, removed ones gone", async () => {
    const id = await registered("rp-drift");
    live.set(urlOf("rp-drift"), [tool("a", "now different"), tool("b")]);
    const res = await reprobe(id);
    expect(res.status).toBe(200);
    expect(res.json.refresh).toMatchObject({
      status: "drifted",
      changed: 1,
      added: 1,
      removed: 1,
    });
    expect(res.json.refresh.message).toBe(
      "1 changed, 1 added, 1 removed. Review them to offer them again.",
    );
    // U7: a changed tool is disabled until re-approved; the new one too.
    const tools = await snapshot(id);
    expect(tools.map((t) => [t.name, t.status]).sort()).toEqual([
      ["a", "drifted"],
      ["b", "drifted"],
    ]);
    expect(res.json.connector).toMatchObject({ driftedCount: 2 });
    const review = await root.get(`${BASE}/${id}/tools`);
    expect(
      review.json.tools.map((t: { name: string; change: string }) => [t.name, t.change]).sort(),
    ).toEqual([
      ["a", "changed"],
      ["b", "added"],
    ]);
    // Counts only: no tool names in the refreshed event.
    const audit = await events("mcp.connector.refreshed", id);
    expect(audit[0]?.target).toEqual({
      connectorId: id,
      name: "rp-drift",
      outcome: "drifted",
      changed: 1,
      added: 1,
      removed: 1,
      credential: "none",
    });
    // The drift itself is recorded as the periodic refresh records it (drift emails rely on it).
    expect(await events("mcp.connector.drift", id)).toHaveLength(1);
  });

  it("pins a connector that has no pins through the pin path", async () => {
    const name = "rp-unpinned";
    const created = await root.post(BASE, { name, url: urlOf(name), authKind: "none" });
    const id = created.json.connector.id as string;
    expect(created.json.pin).toMatchObject({ ok: false, failure: "unreachable" });
    live.set(urlOf(name), [tool("x"), tool("y")]);
    const res = await reprobe(id);
    expect(res.status).toBe(200);
    expect(res.json.refresh).toMatchObject({ status: "pinned", tools: 2 });
    expect((await snapshot(id)).map((t) => t.status)).toEqual(["pinned", "pinned"]);
    expect((await events("mcp.connector.refreshed", id))[0]?.target).toMatchObject({
      outcome: "pinned",
      added: 2,
    });
  });

  it("explains a failed probe in plain words and keeps the pins", async () => {
    const id = await registered("rp-down");
    live.delete(urlOf("rp-down"));
    const res = await reprobe(id);
    expect(res.status).toBe(502);
    expect(res.json).toMatchObject({ code: "reprobe_failed", failure: "unreachable" });
    expect(res.json.message).toMatch(/could not be reached/);
    expect((await snapshot(id)).map((t) => t.status)).toEqual(["pinned", "pinned"]);
    expect((await events("mcp.connector.refreshed", id))[0]?.target).toMatchObject({
      outcome: "failed",
      reason: "unreachable",
    });
  });

  it("probes with the acting admin's key, else the pinning admin's, and never leaks it", async () => {
    const name = "rp-keyed";
    live.set(urlOf(name), [tool("a")]);
    const created = await root.post(BASE, { name, url: urlOf(name), authKind: "api_key" });
    const id = created.json.connector.id as string;
    await h.admin.query(
      `INSERT INTO team_connectors (team_id, connector_id, exposure, enabled_by) VALUES ($1, $2, 'all', $3)`,
      [team, id, rootId],
    );
    expect((await root.put(`/v1/connector-grants/${id}`, { api_key: ADMIN_KEY })).status).toBe(201);
    expect((await root.post(`${BASE}/${id}/pin`)).json.pin).toMatchObject({ ok: true });
    // `other` has no key of their own: the pinning admin's key is used.
    keysSent.length = 0;
    const res = await reprobe(id, other);
    expect(res.status).toBe(200);
    expect(keysSent).toEqual([ADMIN_KEY]);
    const all = JSON.stringify((await h.admin.query(`SELECT target FROM audit_log`)).rows);
    expect(all).not.toContain(ADMIN_KEY);
    expect(JSON.stringify(res.json)).not.toContain(ADMIN_KEY);
    expect((await events("mcp.connector.refreshed", id))[0]?.target).toMatchObject({
      outcome: "unchanged",
      credential: "admin_key",
    });
  });

  it("says when credentials are required", async () => {
    const name = "rp-keyed-none";
    live.set(urlOf(name), [tool("a")]);
    const created = await root.post(BASE, { name, url: urlOf(name), authKind: "api_key" });
    const id = created.json.connector.id as string;
    // Pinned out of band, nobody has a key: the re-probe cannot authenticate.
    await h.admin.query(
      `UPDATE connectors SET tools_snapshot = '[]'::jsonb, tools_hash = repeat('0', 64), pinned_by = NULL WHERE id = $1`,
      [id],
    );
    const res = await reprobe(id);
    expect(res.status).toBe(502);
    expect(res.json).toMatchObject({ code: "reprobe_failed", failure: "auth_required" });
    expect(res.json.message).toMatch(/credentials/);
  });

  it("refuses a disabled connector", async () => {
    const id = await registered("rp-off");
    expect((await root.patch(`${BASE}/${id}`, { status: "disabled" })).status).toBe(200);
    const res = await reprobe(id);
    expect(res.status).toBe(409);
    expect(res.json.code).toBe("connector_disabled");
  });
});

describe("safety", () => {
  it("an admin edit during the probe wins", async () => {
    const id = await registered("rp-edit");
    live.set(urlOf("rp-edit"), [tool("a", "changed upstream")]);
    live.set("https://rp-edit-2.example/mcp", [tool("z")]);
    duringProbe = async () => {
      await h.admin.query(`UPDATE connectors SET url = $2 WHERE id = $1`, [
        id,
        "https://rp-edit-2.example/mcp",
      ]);
    };
    const res = await reprobe(id);
    expect(res.status).toBe(409);
    expect(res.json.code).toBe("changed");
    expect(res.json.message).toMatch(/changed while it was being probed/);
    expect((await snapshot(id)).map((t) => [t.name, t.status])).toEqual([
      ["a", "pinned"],
      ["c", "pinned"],
    ]);
  });

  it("never overlaps a running refresh of the same connector", async () => {
    const id = await registered("rp-busy");
    const lockName = connectorRefreshLockName(id);
    await h.admin.query(`SELECT pg_advisory_lock(hashtextextended($1, 0))`, [lockName]);
    try {
      const res = await reprobe(id);
      expect(res.status).toBe(409);
      expect(res.json.code).toBe("refresh_running");
    } finally {
      await h.admin.query(`SELECT pg_advisory_unlock(hashtextextended($1, 0))`, [lockName]);
    }
    expect((await reprobe(id)).status).toBe(200);
  });

  it("the periodic pass skips a connector a re-probe is checking", async () => {
    const id = await registered("rp-pass");
    live.set(urlOf("rp-pass"), [tool("a", "changed")]);
    const lockName = connectorRefreshLockName(id);
    await h.admin.query(`SELECT pg_advisory_lock(hashtextextended($1, 0))`, [lockName]);
    try {
      await refreshAllConnectors(
        h.deps.database.db,
        h.deps.connectorProbe,
        { info: () => undefined, warn: () => undefined },
        {
          connectorLock: (connectorId) => connectorRefreshLocks(h.deps.database.pool)(connectorId),
        },
      );
    } finally {
      await h.admin.query(`SELECT pg_advisory_unlock(hashtextextended($1, 0))`, [lockName]);
    }
    expect((await snapshot(id)).every((t) => t.status === "pinned")).toBe(true);
  });

  it("is rate-limited per connector", async () => {
    const id = await registered("rp-rate");
    const statuses: number[] = [];
    for (let i = 0; i < 6; i += 1) statuses.push((await reprobe(id)).status);
    expect(statuses.slice(0, 5)).toEqual([200, 200, 200, 200, 200]);
    const limited = await reprobe(id);
    expect(limited.status).toBe(429);
    expect(limited.json.code).toBe("rate_limited");
    expect(statuses[5]).toBe(429);
  });
});
