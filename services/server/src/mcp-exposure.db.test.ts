import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createInternalApp } from "./routes/internal.js";
import { approvalKeyring } from "./approvals/index.js";
import { EventStreamFixture } from "./testing/event-stream-fixture.js";
import {
  INTERNAL_KEY,
  MCP_SESSION_KEY,
  enableConnector,
  leaseRun,
  mcpToken,
  piName,
  registerConnector,
} from "./testing/mcp-fixtures.js";

/**
 * KOBE-106: the server side of the MCP proxy's team-exposure enforcement. Whatever the sandbox
 * sends, a connector the team has not enabled, a drifted tool and a tool outside the exposure are
 * refused with their own reason and an `mcp.tool_call` audit row, before any run is looked at; and
 * nothing is cached, so a change by the team admin applies to the very next list and call.
 */
const fx = new EventStreamFixture();
const live = new Set<string>();
let app: ReturnType<typeof createInternalApp>;

beforeAll(async () => {
  await fx.setup([{}], () => ({
    sandboxWire: { sweep: false },
    approvalKeys: approvalKeyring("a".repeat(48)),
  }));
  app = createInternalApp({
    internalKey: INTERNAL_KEY,
    mcp: fx.replica(0).deps.mcp,
    auth: {
      db: fx.db,
      sessionKey: MCP_SESSION_KEY,
      liveness: { isLive: ({ sandboxId }) => Promise.resolve(live.has(sandboxId)) },
    },
  });
});
afterAll(() => fx.teardown());

type Body = Record<string, unknown>;

async function world(
  exposure: "read_only" | "all" | "custom" | "off",
  enabledTools: string[] = [],
) {
  const owner = await fx.person(`x${randomUUID().slice(0, 4)}`);
  const team = await fx.team(`exp-${randomUUID().slice(0, 6)}`, owner);
  const sandboxId = randomUUID();
  live.add(sandboxId);
  const runId = await fx.run(team, owner);
  const threadId = await leaseRun(fx.admin, team, runId, owner.id, sandboxId);
  const connector = await registerConnector(fx.admin);
  if (exposure !== "off") {
    await enableConnector(fx.admin, team, connector.id, owner.id, exposure, enabledTools);
  }
  const token = mcpToken({ sandboxId, teamId: team, userId: owner.id });
  return { team, owner, connector, token, threadId };
}
type World = Awaited<ReturnType<typeof world>>;

async function post(path: string, body: Body | undefined, token: string) {
  const res = await app.request(`/internal/v1/mcp${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${INTERNAL_KEY}`,
      "kobe-sandbox-token": token,
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { status: res.status, json: (await res.json()) as Body };
}
const list = (w: World) => post(`/connectors/${w.connector.id}/tools`, undefined, w.token);
const call = (w: World, tool: string, extra: Body = {}) =>
  post(
    `/connectors/${w.connector.id}/calls`,
    { tool, thread_id: w.threadId, arguments: { q: "x" }, ...extra },
    w.token,
  );
const names = (r: { json: Body }) => (r.json.tools as { name: string }[]).map((t) => t.name);

async function audit(team: string, action = "mcp.tool_call") {
  const { rows } = await fx.admin.query<{ target: Body }>(
    `SELECT target FROM audit_log WHERE team_id = $1 AND action = $2 ORDER BY seq`,
    [team, action],
  );
  return rows.map((r) => r.target);
}

describe("team exposure at the proxy's server-side check (KOBE-106)", () => {
  it("refuses a connector the team has not enabled: not listed, not callable, audited", async () => {
    const w = await world("off");
    expect((await list(w)).status).toBe(404);
    expect((await call(w, "get_issue")).json).toMatchObject({
      decision: "deny",
      code: "connector_not_enabled",
    });
    const [row] = await audit(w.team);
    expect(row).toMatchObject({
      connectorId: w.connector.id,
      decision: "denied",
      reason: "connector_not_enabled",
    });
    expect(await audit(w.team, "mcp.list_refused")).toEqual([
      expect.objectContaining({ connectorId: w.connector.id, reason: "connector_not_enabled" }),
    ]);
  });

  it("read_only refuses a write tool and an unannotated one, even for a call naming no thread", async () => {
    const w = await world("read_only");
    expect(names(await list(w))).toEqual(["get_issue"]);
    for (const tool of ["create_issue", "delete_issue"]) {
      expect((await call(w, tool, { thread_id: randomUUID() })).json, tool).toMatchObject({
        decision: "deny",
        code: "connector_exposure",
      });
    }
    const rows = await audit(w.team);
    expect(rows.map((r) => r.reason)).toEqual(["connector_exposure", "connector_exposure"]);
    expect(rows[0]).toMatchObject({ tool: piName(w.connector.name, "create_issue") });
    expect((await call(w, "get_issue")).json).toMatchObject({ decision: "allow" });
  });

  it("custom refuses an unticked tool and allows a ticked one", async () => {
    const w = await world("custom", []);
    const ticked = piName(w.connector.name, "create_issue");
    await enableConnector(fx.admin, w.team, w.connector.id, w.owner.id, "custom", [ticked]);
    expect(names(await list(w))).toEqual(["create_issue"]);
    expect((await call(w, "get_issue", { thread_id: randomUUID() })).json).toMatchObject({
      decision: "deny",
      code: "connector_exposure",
    });
    // A write is past the exposure gate; it then needs approval, which is a different refusal.
    expect((await call(w, "create_issue")).json).not.toMatchObject({ code: "connector_exposure" });
  });

  it("still refuses a drifted tool (tool_drifted), whatever the exposure", async () => {
    const w = await world("all");
    expect((await call(w, "rename_issue", { thread_id: randomUUID() })).json).toMatchObject({
      decision: "deny",
      code: "tool_drifted",
    });
    expect(names(await list(w))).not.toContain("rename_issue");
  });

  it("allows an enabled, exposed tool", async () => {
    const w = await world("all");
    expect((await call(w, "get_issue")).json).toMatchObject({ decision: "allow" });
  });

  it("applies exposure changes and disabling to the very next request (no cache)", async () => {
    const w = await world("all");
    expect((await call(w, "create_issue")).json).not.toMatchObject({ code: "connector_exposure" });
    await enableConnector(fx.admin, w.team, w.connector.id, w.owner.id, "read_only");
    expect((await call(w, "create_issue")).json).toMatchObject({ code: "connector_exposure" });
    expect(names(await list(w))).toEqual(["get_issue"]);
    await fx.admin.query(`DELETE FROM team_connectors WHERE team_id = $1`, [w.team]);
    expect((await list(w)).status).toBe(404);
    expect((await call(w, "get_issue")).json).toMatchObject({ code: "connector_not_enabled" });
  });
});
