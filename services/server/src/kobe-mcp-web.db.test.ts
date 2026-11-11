import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { KOBE_ADMIN_RESULT_HIDDEN, type KobeEvent } from "@kobe/protocol";
import { KOBE_MCP_MODE_KEY, withTeam } from "@kobe/db";
import { appendRunEventsInTx } from "./event-stream/append.js";
import { KOBE_ADMIN_WRITE_REASON } from "./policy/kobe-admin-guard.js";
import { KobeMcpHarness, type KobeWorld } from "./testing/kobe-mcp-harness.js";
import type { Person } from "./testing/event-stream-fixture.js";

/**
 * KA-6 (KOBE-623, spec kobe-admin-mcp §6–§8): what the web relies on from the server. The
 * "Admin change" card's server summary, the team level and site switch round trips, audit "via
 * agent" with a thread link only for those who may read it, and shared-thread redaction of Kobe
 * admin results wherever a reader is served a tool's output.
 */

const h = new KobeMcpHarness();

beforeAll(() => h.setup(), 120_000);
afterAll(() => h.teardown());
beforeEach(() => h.reset());

async function makeTeamAdmin(team: string, p: Person): Promise<void> {
  await h.fx.admin.query(
    `UPDATE team_members SET role = 'team_admin' WHERE team_id = $1 AND user_id = $2`,
    [team, p.id],
  );
}

async function makeSiteAdmin(p: Person): Promise<void> {
  await h.fx.admin.query(
    `INSERT INTO site_roles (user_id, role) VALUES ($1, 'admin') ON CONFLICT DO NOTHING`,
    [p.id],
  );
}

describe("the Admin change approval card", () => {
  it("carries the scope and the server's summary with names, never for other tools", async () => {
    const w = await h.world();
    const s = await h.sandboxFor(w.team, w.admin);
    const { rows } = await h.fx.admin.query<{ name: string }>(
      `SELECT name FROM teams WHERE id = $1`,
      [w.team],
    );
    const ask = async (
      tool: string,
      input: Record<string, unknown>,
      code: typeof KOBE_ADMIN_WRITE_REASON | "team_ask_rule",
    ) => {
      const abort = new AbortController();
      let approvalId = "";
      const outcome = h.fx.replica(0).deps.approvals.broker.request(
        {
          teamId: w.team,
          userId: w.admin.id,
          connectionId: randomUUID(),
          runId: s.runId,
          threadId: s.threadId,
          toolCallId: `tc-${randomUUID().slice(0, 8)}`,
          tool,
          input,
          decision: {
            effect: "require_approval",
            risk: "write",
            reasons: [{ code, stage: "ask_rule", message: "asks" }],
            expires_at: new Date(Date.now() + 60_000).toISOString(),
          },
          signal: abort.signal,
        },
        (p) => {
          approvalId = p.approvalId;
          abort.abort();
        },
      );
      await outcome;
      const { rows: events } = await h.fx.admin.query<{ payload: Record<string, unknown> }>(
        `SELECT payload FROM run_events WHERE team_id = $1 AND run_id = $2
          AND type = 'approval.requested' AND payload ->> 'approval_id' = $3`,
        [w.team, s.runId, approvalId],
      );
      return events[0]?.payload;
    };
    const input = { user_id: w.target.id, from_role: "member", to_role: "team_admin" };
    const card = await ask(h.pi("team_members_set_role"), input, KOBE_ADMIN_WRITE_REASON);
    const { rows: names } = await h.fx.admin.query<{ name: string }>(
      `SELECT name FROM users WHERE id = $1`,
      [w.target.id],
    );
    expect(card?.input).toEqual(input);
    expect(card?.admin).toEqual({
      scope: "team",
      scope_label: `Team ${rows[0]?.name}`,
      summary: `Change the role of member ${names[0]?.name}: Member → Team admin`,
    });
    const plain = await ask("bash", { command: "ls" }, "team_ask_rule");
    expect(plain).toBeDefined();
    expect(plain).not.toHaveProperty("admin");
  });
});

describe("Team console › Connectors: the Kobe level", () => {
  it("round-trips for a team admin, audited; members read it but cannot change it", async () => {
    const w = await h.world(null);
    const got = await w.admin.browser.get("/v1/team/connectors/kobe");
    expect(got.status).toBe(200);
    expect(got.json.kobe).toMatchObject({ name: "kobe", mode: "admin", level: "docs" });
    expect(got.json.kobe.docs_tools).toContain(h.pi("docs_index"));
    expect(got.json.kobe.admin_tools).toContainEqual({
      pi_name: h.pi("team_members_set_role"),
      title: expect.any(String),
      scope: "team",
      read_only: false,
    });

    const set = await w.admin.browser.put("/v1/team/connectors/kobe", {
      level: "read",
      expected_level: "docs",
    });
    expect(set.status, JSON.stringify(set.json)).toBe(200);
    expect(set.json.kobe.level).toBe("read");
    expect((await w.admin.browser.get("/v1/team/connectors/kobe")).json.kobe.level).toBe("read");
    // The member's listing now has the admin reads the switches allow (none for a member's role).
    const stale = await w.admin.browser.put("/v1/team/connectors/kobe", {
      level: "read_write",
      expected_level: "docs",
    });
    expect(stale.status).toBe(409);
    expect(stale.json.code).toBe("changed_since_approval");

    expect((await w.member.browser.get("/v1/team/connectors/kobe")).status).toBe(200);
    const refused = await w.member.browser.put("/v1/team/connectors/kobe", { level: "read_write" });
    expect(refused.status).toBe(403);
    const bad = await w.admin.browser.put("/v1/team/connectors/kobe", { level: "all" });
    expect(bad.status).toBe(400);

    const { rows } = await h.fx.admin.query<{ target: Record<string, unknown> }>(
      `SELECT target FROM audit_log WHERE team_id = $1 AND action = 'mcp.kobe.team_level_changed'`,
      [w.team],
    );
    expect(rows.map((r) => r.target)).toEqual([{ from: "docs", to: "read" }]);
  });
});

describe("Site console › Settings: the Kobe MCP switch", () => {
  it("round-trips for a site admin, audited; others are refused", async () => {
    const w = await h.world();
    await h.setSite(KOBE_MCP_MODE_KEY, null);
    await makeSiteAdmin(w.admin);
    const before = await w.admin.browser.get("/v1/site/settings");
    expect(before.status).toBe(200);
    expect(before.json.kobeMcpMode).toBe("docs");
    const off = await w.admin.browser.put("/v1/site/settings", { kobeMcpMode: "off" });
    expect(off.status, JSON.stringify(off.json)).toBe(200);
    expect(off.json.kobeMcpMode).toBe("off");
    expect((await w.admin.browser.get("/v1/team/connectors/kobe")).json.kobe.mode).toBe("off");
    expect((await w.admin.browser.put("/v1/site/settings", { kobeMcpMode: "all" })).status).toBe(
      400,
    );
    expect((await w.member.browser.put("/v1/site/settings", { kobeMcpMode: "admin" })).status).toBe(
      403,
    );
    const { rows } = await h.fx.admin.query<{ target: Record<string, unknown> }>(
      `SELECT target FROM audit_log WHERE action = 'site.settings.updated'
        AND target ->> 'setting' = 'kobe_mcp_mode' ORDER BY seq`,
    );
    expect(rows.at(-1)?.target).toEqual({ setting: "kobe_mcp_mode", value: "off" });
  });
});

describe("audit views: via agent", () => {
  it("names thread, run and tool call; links the thread only for those who may read it", async () => {
    const w = await h.world();
    const s = await h.sandboxFor(w.team, w.admin);
    const { out } = await h.approvedCall(s, "team_members_set_role", {
      user_id: w.target.id,
      from_role: "member",
      to_role: "team_admin",
    });
    expect(out.isError).toBeUndefined();
    const via = (body: { events: Record<string, unknown>[] }) =>
      body.events.find((e) => e.action === "identity.member.role_changed")?.viaAgent as
        Record<string, unknown> | undefined;

    const own = await w.admin.browser.get("/v1/team/audit?limit=50");
    expect(own.status).toBe(200);
    expect(via(own.json)).toMatchObject({
      threadId: s.threadId,
      runId: s.runId,
      threadOpen: true,
    });
    // The promoted target is a team admin now: the private thread is not theirs to open.
    const other = await w.target.browser.get("/v1/team/audit?limit=50");
    expect(other.status).toBe(200);
    expect(via(other.json)).toMatchObject({ threadId: s.threadId, threadOpen: false });

    // Shared with the team, the other admin may open it.
    await h.fx.admin.query(`UPDATE threads SET shared_to_team = true WHERE id = $1`, [s.threadId]);
    expect(via((await w.target.browser.get("/v1/team/audit?limit=50")).json)?.threadOpen).toBe(
      true,
    );

    // A site admin outside the team sees the record, never a way into the thread.
    const outsider = await h.fx.person(`so${randomUUID().slice(0, 4)}`);
    await makeSiteAdmin(outsider);
    const site = await outsider.browser.get(`/v1/site/audit?limit=50&teamId=${w.team}`);
    expect(site.status, JSON.stringify(site.json)).toBe(200);
    expect(via(site.json)).toMatchObject({ threadId: s.threadId, threadOpen: false });
  });
});

describe("shared threads hide Kobe admin results (KA6)", () => {
  const SECRET = "ana@example.test team_admin";

  async function sharedThread(w: KobeWorld) {
    const s = await h.sandboxFor(w.team, w.admin);
    const result = (id: string, parent: string | null, tool: string, text: string) =>
      h.fx.admin.query(
        `INSERT INTO thread_entries (team_id, thread_id, entry_id, parent_id, type, payload)
         VALUES ($1, $2, $3, $4, 'message', $5)`,
        [
          w.team,
          s.threadId,
          id,
          parent,
          JSON.stringify({
            type: "message",
            id,
            message: {
              role: "toolResult",
              toolCallId: `tc-${id}`,
              toolName: tool,
              content: [{ type: "text", text }],
              details: { text },
              isError: false,
            },
          }),
        ],
      );
    await result("e1", null, h.pi("team_members_list"), SECRET);
    await result("e2", "e1", h.pi("docs_index"), "# Kobe docs");
    await h.fx.admin.query(
      `UPDATE threads SET shared_to_team = true, leaf_entry_id = 'e2' WHERE id = $1`,
      [s.threadId],
    );
    return s;
  }

  const entry = (body: { entries: { entry_id: string }[] }, id: string) =>
    body.entries.find((e) => e.entry_id === id) as Record<string, unknown> | undefined;

  it("serves the entry list, the thread and the full output without the result", async () => {
    const w = await h.world();
    const s = await sharedThread(w);
    for (const path of [`/v1/threads/${s.threadId}`, `/v1/threads/${s.threadId}/entries`]) {
      const read = await w.member.browser.get(path);
      expect(read.status, path).toBe(200);
      expect(JSON.stringify(read.json)).not.toContain("ana@example.test");
      expect(entry(read.json, "e1")).toMatchObject({ admin_result_hidden: true });
      expect(JSON.stringify(entry(read.json, "e1"))).toContain(KOBE_ADMIN_RESULT_HIDDEN);
      // The docs tools are never hidden, and the call itself still shows.
      expect(JSON.stringify(entry(read.json, "e2"))).toContain("# Kobe docs");
      expect(JSON.stringify(entry(read.json, "e1"))).toContain(h.pi("team_members_list"));
    }
    const output = await w.member.browser.get(`/v1/threads/${s.threadId}/entries/e1/output`);
    expect(output.status).toBe(200);
    expect(output.json).toMatchObject({
      text: KOBE_ADMIN_RESULT_HIDDEN,
      admin_result_hidden: true,
    });
  });

  it("shows everything to the owner and to a reader holding the tool's permission", async () => {
    const w = await h.world();
    const s = await sharedThread(w);
    const owner = await w.admin.browser.get(`/v1/threads/${s.threadId}/entries`);
    expect(JSON.stringify(owner.json)).toContain("ana@example.test");
    expect(entry(owner.json, "e1")).not.toHaveProperty("admin_result_hidden");
    await makeTeamAdmin(w.team, w.target);
    const peer = await w.target.browser.get(`/v1/threads/${s.threadId}/entries`);
    expect(JSON.stringify(peer.json)).toContain("ana@example.test");
    const out = await w.target.browser.get(`/v1/threads/${s.threadId}/entries/e1/output`);
    expect(out.json.text).toBe(SECRET);
  });

  it("keeps the result hidden in a reader's fork", async () => {
    const w = await h.world();
    const s = await sharedThread(w);
    const fork = await w.member.browser.post(`/v1/threads/${s.threadId}/fork`, {});
    expect(fork.status, JSON.stringify(fork.json)).toBe(201);
    const { rows } = await h.fx.admin.query<{ payload: unknown }>(
      `SELECT payload FROM thread_entries WHERE team_id = $1 AND thread_id = $2`,
      [w.team, fork.json.thread_id],
    );
    expect(rows).toHaveLength(2);
    expect(JSON.stringify(rows)).not.toContain("ana@example.test");
    expect(JSON.stringify(rows)).toContain("# Kobe docs");
  });

  it("hides tool.result previews in a reader's event stream", async () => {
    const w = await h.world();
    const s = await sharedThread(w);
    await withTeam(h.fx.db, w.team, (tx) =>
      appendRunEventsInTx(tx, w.team, s.runId, [
        {
          type: "tool.result",
          payload: {
            tool_call_id: "tc-e1",
            tool: h.pi("team_members_list"),
            is_error: false,
            preview: SECRET,
            truncated: false,
          },
        },
      ]),
    );
    await h.fx.complete(w.team, s.runId);
    const results = async (p: Person) =>
      (await (await h.fx.stream(0, p, s.runId)).rest()).filter(
        (e): e is KobeEvent<"tool.result"> => e.type === "tool.result",
      );
    expect((await results(w.member)).map((e) => e.payload.preview)).toEqual([
      KOBE_ADMIN_RESULT_HIDDEN,
    ]);
    expect((await results(w.admin)).map((e) => e.payload.preview)).toEqual([SECRET]);
  });
});

describe("the composer's Connectors list the built-in Kobe connector", () => {
  it("always on, with the admin tools the member would get; no toggle", async () => {
    const w = await h.world("read");
    const kobeRow = async (p: Person) =>
      (
        (await p.browser.get("/v1/threads/connectors")).json.connectors as Record<string, unknown>[]
      ).find((c) => c.builtin !== undefined);
    expect(await kobeRow(w.admin)).toMatchObject({
      name: "kobe",
      enabled: true,
      problem: null,
      builtin: { kind: "kobe", admin: "read" },
    });
    expect(await kobeRow(w.member)).toMatchObject({ builtin: { kind: "kobe", admin: "off" } });
    await h.setLevel(w.team, "read_write");
    expect((await kobeRow(w.admin))?.builtin).toEqual({ kind: "kobe", admin: "read_write" });

    const s = await h.sandboxFor(w.team, w.admin);
    const id = (await kobeRow(w.admin))?.connector_id as string;
    const off = await w.admin.browser.put(`/v1/threads/${s.threadId}/connectors/${id}`, {
      enabled: false,
    });
    expect(off.status).toBe(409);
    expect(off.json.code).toBe("connector_always_on");
    const created = await w.admin.browser.post("/v1/threads", { connectors_off: [id] });
    expect(created.status).toBe(422);

    await h.setSite(KOBE_MCP_MODE_KEY, "off");
    expect(await kobeRow(w.admin)).toBeUndefined();
  });
});
