import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { withTeam } from "@kobe/db";
import { PINNED_AGENTS } from "./runs/agents.js";
import { enableConnector, registerConnector } from "./testing/mcp-fixtures.js";
import { RunFixture } from "./testing/run-fixture.js";
import type { Person } from "./testing/event-stream-fixture.js";

/**
 * KOBE-451 ac-2/ac-3/ac-6: the composer's Connectors. The list is exactly the member's usable
 * servers (team-enabled, exposed, a usable credential), a broken one says why in fixed words; the
 * owner's per-thread toggle is stored server-side and the next run's MCP set follows it; a forged
 * toggle (another's thread, a connector not offered, one not working) is refused; a new thread
 * starts with everything on.
 */
const f = new RunFixture();
const ANY = { "if-match": "*" };
type Json = Record<string, unknown>;
type Listed = {
  connector_id: string;
  name: string;
  enabled: boolean;
  problem: { code: string; message: string; fix: { href: string } | null } | null;
};

beforeAll(async () => {
  await f.setup();
});
afterAll(async () => {
  await f.teardown();
});

async function catalog(team: string, ownerId: string) {
  const admin = f.fx.admin;
  await admin.query(
    `INSERT INTO model_providers (id, kind, name, api_key_enc, created_by)
     VALUES ('openai', 'openai', 'openai', 'v2.test.sealed-provider-key', $1) ON CONFLICT (id) DO NOTHING`,
    [ownerId],
  );
  await admin.query(
    `INSERT INTO model_catalog (alias, provider_id, model, created_by)
     VALUES ('fast', 'openai', 'fast-fake', $1) ON CONFLICT (alias) DO NOTHING`,
    [ownerId],
  );
  await admin.query(
    `INSERT INTO team_models (team_id, alias, is_default, enabled_by) VALUES ($1, 'fast', true, $2)`,
    [team, ownerId],
  );
}

async function agentThread(p: Person, connectors: string[]): Promise<string> {
  const b = f.on(0, p);
  const created = await b.post("/v1/agents", {
    scope: "team",
    frontmatter: { name: "Connected", connectors },
    prompt: "You are connected.",
  });
  expect(created.status, JSON.stringify(created.json)).toBe(201);
  const id = created.json.agent.id as string;
  expect((await b.request("POST", `/v1/agents/${id}/publish`, {}, ANY)).status).toBe(201);
  const thread = await b.post("/v1/threads", { agent_id: id });
  expect(thread.status).toBe(201);
  return thread.json.thread_id as string;
}

const grant = (team: string, user: string, connector: string, kind: string, expires: string) =>
  f.fx.admin.query(
    `INSERT INTO connector_grants (team_id, user_id, connector_id, kind, sealed, key_id, hint, expires_at)
     VALUES ($1, $2, $3, $4, 'e1.k.sealed', 'k', '', $5)`,
    [team, user, connector, kind, expires === "" ? null : expires],
  );

async function mcpOf(team: string, ownerId: string, thread: string): Promise<string[]> {
  const db = f.fx.replica(0).deps.database.db;
  return withTeam(db, team, async (tx) => {
    const { rows } = await tx.execute<{ agent_scope: string; agent_id: string; v: number }>(
      `SELECT agent_scope, agent_id, agent_version AS v FROM threads WHERE id = '${thread}'`,
    );
    const t = rows[0];
    if (t === undefined) throw new Error("thread row missing");
    const res = await PINNED_AGENTS.resolve(tx, {
      teamId: team,
      ownerUserId: ownerId,
      threadId: thread,
      runId: "00000000-0000-4000-8000-000000000000",
      trigger: "user",
      agentScope: t.agent_scope as "team",
      agentId: t.agent_id,
      agentVersion: t.v,
      approvalMode: "auto",
    });
    return res.ok ? (res.mcp?.servers.map((s) => s.name) ?? []) : ["failed"];
  });
}

async function setup() {
  const w = await f.world(1);
  await catalog(w.team, w.owner.id);
  const tag = randomBytes(3).toString("hex");
  const keyed = await registerConnector(f.fx.admin, { name: `keyed-${tag}`, authKind: "api_key" });
  const bare = await registerConnector(f.fx.admin, { name: `bare-${tag}`, authKind: "api_key" });
  const stale = await registerConnector(f.fx.admin, { name: `stale-${tag}`, authKind: "oauth" });
  const open = await registerConnector(f.fx.admin, { name: `open-${tag}`, authKind: "none" });
  const elsewhere = await registerConnector(f.fx.admin, { name: `other-${tag}`, authKind: "none" });
  for (const c of [keyed, bare, stale, open]) {
    await enableConnector(f.fx.admin, w.team, c.id, w.owner.id, "read_only");
  }
  await grant(w.team, w.owner.id, keyed.id, "api_key", "");
  await grant(w.team, w.owner.id, stale.id, "oauth", "2020-01-01T00:00:00Z");
  const names = [keyed, bare, stale, open].map((c) => c.name);
  const thread = await agentThread(w.owner, names);
  return { w, keyed, bare, stale, open, elsewhere, thread, names };
}

const listOf = (json: Json) => json.connectors as Listed[];

describe("the composer's connectors (KOBE-451)", () => {
  it("ac-2/ac-3: lists exactly the member's servers; broken ones say why, with fixed words", async () => {
    const s = await setup();
    const res = await f.on(0, s.w.owner).get(`/v1/threads/${s.thread}/connectors`);
    expect(res.status).toBe(200);
    const list = listOf(res.json);
    expect(list.map((c) => [c.name, c.enabled, c.problem?.code ?? null])).toEqual(
      [
        [s.bare.name, true, "no_key"],
        [s.keyed.name, true, null],
        [s.open.name, true, null],
        [s.stale.name, true, "grant_expired"],
      ].sort((a, b) => String(a[0]).localeCompare(String(b[0]))),
    );
    expect(list.find((c) => c.name === s.bare.name)?.problem?.fix?.href).toBe("/me/connectors");
    // No URL, credential or upstream detail in what the member reads.
    expect(JSON.stringify(list)).not.toMatch(/https?:\/\/|e1\.|sealed|mcp\.example/i);
    // A conversation not started yet: the same list, all on.
    const draft = await f.on(0, s.w.owner).get("/v1/threads/connectors");
    expect(listOf(draft.json).map((c) => c.name)).toEqual(list.map((c) => c.name));
  });

  it("ac-2/ac-6: off for this thread leaves the next run's MCP set; on brings it back; a new thread starts on", async () => {
    const s = await setup();
    const b = f.on(0, s.w.owner);
    expect(await mcpOf(s.w.team, s.w.owner.id, s.thread)).toEqual([s.keyed.name, s.open.name]);
    const off = await b.put(`/v1/threads/${s.thread}/connectors/${s.keyed.id}`, { enabled: false });
    expect(off.status, JSON.stringify(off.json)).toBe(200);
    expect(off.json.connector).toMatchObject({ connector_id: s.keyed.id, enabled: false });
    expect(await mcpOf(s.w.team, s.w.owner.id, s.thread)).toEqual([s.open.name]);
    const listed = listOf((await b.get(`/v1/threads/${s.thread}/connectors`)).json);
    expect(listed.find((c) => c.connector_id === s.keyed.id)?.enabled).toBe(false);

    // This thread only: another thread of the same agent and the draft list keep it on.
    const fresh = await b.post("/v1/threads", {
      agent_id: (
        await f.fx.admin.query<{ agent_id: string }>(`SELECT agent_id FROM threads WHERE id = $1`, [
          s.thread,
        ])
      ).rows[0]?.agent_id,
    });
    const other = fresh.json.thread_id as string;
    expect(await mcpOf(s.w.team, s.w.owner.id, other)).toEqual([s.keyed.name, s.open.name]);
    expect(
      listOf((await b.get(`/v1/threads/${other}/connectors`)).json).every((c) => c.enabled),
    ).toBe(true);

    const on = await b.put(`/v1/threads/${s.thread}/connectors/${s.keyed.id}`, { enabled: true });
    expect(on.status).toBe(200);
    expect(await mcpOf(s.w.team, s.w.owner.id, s.thread)).toEqual([s.keyed.name, s.open.name]);
    const { rows } = await f.fx.admin.query<{ target: Json }>(
      `SELECT target FROM audit_log WHERE action = 'thread.connector_toggled' AND team_id = $1 ORDER BY seq`,
      [s.w.team],
    );
    expect(rows.map((r) => r.target)).toEqual([
      { threadId: s.thread, connectorId: s.keyed.id, enabled: false },
      { threadId: s.thread, connectorId: s.keyed.id, enabled: true },
    ]);
  });

  it("ac-2: a forged toggle is refused: not working, not offered, another's thread", async () => {
    const s = await setup();
    const b = f.on(0, s.w.owner);
    const put = (thread: string, connector: string, who = b) =>
      who.put(`/v1/threads/${thread}/connectors/${connector}`, { enabled: false });
    expect((await put(s.thread, s.bare.id)).status).toBe(409);
    expect((await put(s.thread, s.stale.id)).status).toBe(409);
    expect((await put(s.thread, s.elsewhere.id)).status).toBe(404);
    const mate = s.w.others[0];
    if (mate === undefined) throw new Error("no teammate");
    expect((await put(s.thread, s.open.id, f.on(0, mate))).status).toBe(404);
    expect((await f.on(0, mate).get(`/v1/threads/${s.thread}/connectors`)).status).toBe(404);
    expect((await b.put(`/v1/threads/${s.thread}/connectors/${s.open.id}`, {})).status).toBe(400);
    expect(await mcpOf(s.w.team, s.w.owner.id, s.thread)).toEqual([s.keyed.name, s.open.name]);
    const { rows } = await f.fx.admin.query(
      `SELECT 1 FROM audit_log WHERE action = 'thread.connector_toggled' AND team_id = $1`,
      [s.w.team],
    );
    expect(rows).toEqual([]);
  });

  it("ac-3: tools awaiting approval and a refresh that needs credentials are not working", async () => {
    const s = await setup();
    await f.fx.admin.query(
      `UPDATE connectors SET tools_snapshot = (
         SELECT jsonb_agg(jsonb_set(t, '{status}', '"drifted"')) FROM jsonb_array_elements(tools_snapshot) t)
       WHERE id = $1`,
      [s.open.id],
    );
    await f.fx.admin.query(
      `UPDATE connectors SET refresh_skipped = 'auth_required' WHERE id = $1`,
      [s.keyed.id],
    );
    const list = listOf((await f.on(0, s.w.owner).get(`/v1/threads/${s.thread}/connectors`)).json);
    const problem = (id: string) => list.find((c) => c.connector_id === id)?.problem?.code;
    expect(problem(s.open.id)).toBe("tools_awaiting_approval");
    expect(problem(s.keyed.id)).toBe("refresh_auth_required");
  });
});
