import { createHash, randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { canonicalJson, type JsonObject } from "@kobe/protocol";
import { approvalKeyring } from "./approvals/index.js";
import { DENY_UNVERIFIED_APPROVALS } from "./mcp/approvals.js";
import { createDbMcpCatalog } from "./mcp/catalog.js";
import { createMcpService } from "./mcp/service.js";
import { createPolicyEngine } from "./policy/engine.js";
import { createToolRegistry } from "./policy/registry.js";
import { createDbRuleSource } from "./policy/rule-store.js";
import { createDbRunContextSource } from "./sandbox-wire/index.js";
import { createInternalApp } from "./routes/internal.js";
import { EventStreamFixture, type Person } from "./testing/event-stream-fixture.js";
import {
  INTERNAL_KEY,
  MCP_SESSION_KEY,
  allowApproval,
  WIRE_SESSION_KEY,
  enableConnector,
  leaseRun,
  mcpToken,
  piName,
  registerConnector,
} from "./testing/mcp-fixtures.js";

/**
 * The MCP proxy's policy re-check on the server (KOBE-58) against a real Postgres: sandbox
 * authentication, exposure, run binding, the policy engine at `enforcement_point: mcp_proxy`,
 * signed approvals (Gate 2: a tampered kobe-policy cannot execute an MCP write without a valid
 * signed approval) and the `mcp.tool_call` audit.
 */
const fx = new EventStreamFixture();
const KEYRING = approvalKeyring("a".repeat(48));
const FORGED = { kid: KEYRING.current.kid, secret: new Uint8Array(32).fill(9) };
const live = new Set<string>();
let app: ReturnType<typeof createInternalApp>;

beforeAll(async () => {
  await fx.setup([{}], () => ({
    sandboxWire: { sweep: false },
    approvalKeys: KEYRING,
  }));
  app = internalApp(fx.replica(0).deps.mcp);
});
afterAll(() => fx.teardown());

function internalApp(mcp: ReturnType<typeof createMcpService>) {
  return createInternalApp({
    internalKey: INTERNAL_KEY,
    mcp,
    auth: {
      db: fx.db,
      sessionKey: MCP_SESSION_KEY,
      liveness: { isLive: ({ sandboxId }) => Promise.resolve(live.has(sandboxId)) },
    },
  });
}

interface World {
  readonly team: string;
  readonly owner: Person;
  readonly sandboxId: string;
  readonly token: string;
  readonly runId: string;
  readonly threadId: string;
  readonly connector: { id: string; name: string };
}

async function world(
  options: { exposure?: "read_only" | "all" | "custom"; enabledTools?: string[] } = {},
): Promise<World> {
  const owner = await fx.person(`m${randomUUID().slice(0, 4)}`);
  const team = await fx.team(`mcp-${randomUUID().slice(0, 6)}`, owner);
  const sandboxId = randomUUID();
  live.add(sandboxId);
  const runId = await fx.run(team, owner);
  const threadId = await leaseRun(fx.admin, team, runId, owner.id, sandboxId);
  const connector = await registerConnector(fx.admin);
  await enableConnector(
    fx.admin,
    team,
    connector.id,
    owner.id,
    options.exposure ?? "all",
    options.enabledTools ?? [],
  );
  const token = mcpToken({ sandboxId, teamId: team, userId: owner.id });
  return { team, owner, sandboxId, token, runId, threadId, connector };
}

type Body = Record<string, unknown>;

async function post(
  path: string,
  body: Body | undefined,
  headers: Record<string, string>,
  target = app,
): Promise<{ status: number; json: Body }> {
  const res = await target.request(`/internal/v1/mcp${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { status: res.status, json: (await res.json()) as Body };
}

const auth = (token: string) => ({
  authorization: `Bearer ${INTERNAL_KEY}`,
  "kobe-sandbox-token": token,
});
const listTools = (w: World, token = w.token, target = app) =>
  post(`/connectors/${w.connector.id}/tools`, undefined, auth(token), target);
const callTool = (w: World, body: Body, token = w.token, target = app) =>
  post(
    `/connectors/${w.connector.id}/calls`,
    { thread_id: w.threadId, arguments: { q: "x" }, ...body },
    auth(token),
    target,
  );

async function auditRows(team: string) {
  const { rows } = await fx.admin.query<{ target: Body; actor_id: string }>(
    `SELECT target, actor_id FROM audit_log WHERE team_id = $1 AND action = 'mcp.tool_call' ORDER BY seq`,
    [team],
  );
  return rows;
}

const digest = (input: JsonObject) =>
  createHash("sha256").update(canonicalJson(input)).digest("hex");

describe("internal listener authentication", () => {
  let w: World;
  beforeAll(async () => {
    w = await world();
  });

  it("refuses requests without the proxy's internal key", async () => {
    expect((await post(`/connectors/${w.connector.id}/tools`, undefined, {})).status).toBe(401);
    const wrong = { authorization: `Bearer ${"x".repeat(40)}`, "kobe-sandbox-token": w.token };
    expect((await post(`/connectors/${w.connector.id}/tools`, undefined, wrong)).status).toBe(401);
  });

  it("refuses requests that came through a proxy or ingress (forwarded headers)", async () => {
    const res = await post(`/connectors/${w.connector.id}/tools`, undefined, {
      ...auth(w.token),
      "x-forwarded-for": "203.0.113.9",
    });
    expect(res.status).toBe(404);
  });

  it("refuses a missing, forged, expired or other-audience sandbox token", async () => {
    const claims = { sandboxId: w.sandboxId, teamId: w.team, userId: w.owner.id };
    for (const token of [
      "",
      "forged.token.value",
      mcpToken(claims, { key: "f".repeat(48) }),
      mcpToken(claims, { ttl: -60 }),
      mcpToken(claims, { audience: "kobe.sandbox-wire", key: WIRE_SESSION_KEY }),
    ]) {
      const res = await listTools(w, token);
      expect(res.status, token).toBe(401);
      expect(res.json.code).toBe("sandbox_unauthorized");
    }
  });

  it("refuses a validly signed token for a sandbox that is no longer live", async () => {
    const token = mcpToken({ sandboxId: randomUUID(), teamId: w.team, userId: w.owner.id });
    expect((await listTools(w, token)).json).toMatchObject({ message: "not_live" });
  });

  it("refuses a token whose user left the team or was deactivated", async () => {
    const other = await fx.person(`o${randomUUID().slice(0, 4)}`);
    const sandboxId = randomUUID();
    live.add(sandboxId);
    const token = mcpToken({ sandboxId, teamId: w.team, userId: other.id });
    expect((await listTools(w, token)).json).toMatchObject({ message: "not_allowed" });
  });
});

describe("tools/list exposure (D27)", () => {
  it("lists every pinned tool under `all`, never drifted ones", async () => {
    const w = await world();
    const res = await listTools(w);
    expect(res.status).toBe(200);
    const names = (res.json.tools as { name: string }[]).map((t) => t.name);
    expect(names).toEqual(["get_issue", "create_issue", "delete_issue"]);
  });

  it("lists only readOnlyHint tools under `read_only`", async () => {
    const w = await world({ exposure: "read_only" });
    const names = ((await listTools(w)).json.tools as { name: string }[]).map((t) => t.name);
    expect(names).toEqual(["get_issue"]);
  });

  it("lists only the enabled tools under `custom`", async () => {
    const w = await world({ exposure: "custom" });
    await enableConnector(fx.admin, w.team, w.connector.id, w.owner.id, "custom", [
      piName(w.connector.name, "create_issue"),
    ]);
    const names = ((await listTools(w)).json.tools as { name: string }[]).map((t) => t.name);
    expect(names).toEqual(["create_issue"]);
  });

  it("answers 404 for a connector the team has not enabled, another team's, or a disabled one", async () => {
    const w = await world();
    const notEnabled = await registerConnector(fx.admin);
    const disabled = await registerConnector(fx.admin, { status: "disabled" });
    await enableConnector(fx.admin, w.team, disabled.id, w.owner.id);
    const other = await world();
    for (const id of [notEnabled.id, disabled.id, other.connector.id, "not-a-uuid"]) {
      const res = await post(`/connectors/${id}/tools`, undefined, auth(w.token));
      expect(res.status, id).toBe(404);
    }
  });
});

describe("tools/call: the server decides every call", () => {
  it("allows a read tool and records the call (metadata only)", async () => {
    const w = await world();
    const res = await callTool(w, { tool: "get_issue", tool_call_id: "toolu_1" });
    expect(res.json).toMatchObject({
      decision: "allow",
      tool: { name: "get_issue", pi_name: piName(w.connector.name, "get_issue") },
      connector: { id: w.connector.id, url: "https://mcp.example.com/mcp", auth_kind: "none" },
      input_sha256: digest({ q: "x" }),
    });
    const [row] = await auditRows(w.team);
    expect(row?.actor_id).toBe(w.owner.id);
    expect(row?.target).toEqual({
      sandboxId: w.sandboxId,
      userId: w.owner.id,
      connectorId: w.connector.id,
      tool: piName(w.connector.name, "get_issue"),
      runId: w.runId,
      threadId: w.threadId,
      toolCallId: "toolu_1",
      decision: "allowed",
      reason: "risk_read",
      risk: "read",
    });
    expect(JSON.stringify(row?.target)).not.toContain('"q"');
  });

  it("denies a tool that is not pinned (unknown) and one that drifted", async () => {
    const w = await world();
    expect((await callTool(w, { tool: "exfiltrate" })).json).toMatchObject({
      decision: "deny",
      code: "unknown_tool",
    });
    expect((await callTool(w, { tool: "rename_issue" })).json).toMatchObject({
      decision: "deny",
      code: "tool_drifted",
    });
  });

  it("denies a tool outside the team's exposure", async () => {
    const w = await world({ exposure: "read_only" });
    expect((await callTool(w, { tool: "create_issue" })).json).toMatchObject({
      decision: "deny",
      code: "connector_exposure",
    });
  });

  it("denies a call that names no thread, another user's thread, or a run not leased here", async () => {
    const w = await world();
    const noThread = await post(
      `/connectors/${w.connector.id}/calls`,
      { tool: "get_issue", arguments: {} },
      auth(w.token),
    );
    expect(noThread.json).toMatchObject({ decision: "deny", code: "run_not_active" });

    const other = await world();
    expect(
      (await callTool(w, { tool: "get_issue", thread_id: other.threadId })).json,
    ).toMatchObject({ decision: "deny", code: "run_not_active" });

    // The same user's run on another sandbox: not this sandbox's to use.
    const runId = await fx.run(w.team, w.owner);
    const threadId = await leaseRun(fx.admin, w.team, runId, w.owner.id, randomUUID());
    expect((await callTool(w, { tool: "get_issue", thread_id: threadId })).json).toMatchObject({
      decision: "deny",
      code: "run_not_active",
    });
  });

  it("denies once the run has ended", async () => {
    const w = await world();
    await fx.complete(w.team, w.runId);
    expect((await callTool(w, { tool: "get_issue" })).json).toMatchObject({
      decision: "deny",
      code: "run_not_active",
    });
  });

  it("denies invalid inputs (not an object, __proto__, unsafe integers)", async () => {
    const w = await world();
    for (const args of [[1], "text", { n: 2 ** 60 }]) {
      expect((await callTool(w, { tool: "get_issue", arguments: args })).json).toMatchObject({
        decision: "deny",
        code: "invalid_input",
      });
    }
    const proto = await app.request(`/internal/v1/mcp/connectors/${w.connector.id}/calls`, {
      method: "POST",
      headers: { "content-type": "application/json", ...auth(w.token) },
      body: `{"tool":"get_issue","thread_id":"${w.threadId}","arguments":{"__proto__":{"x":1}}}`,
    });
    expect(await proto.json()).toMatchObject({ decision: "deny", code: "invalid_input" });
  });

  it("applies team deny rules at the proxy too", async () => {
    const w = await world();
    await fx.admin.query(
      `INSERT INTO tool_rules (team_id, scope, effect, tool_glob, created_by)
       VALUES ($1, 'team', 'deny', $2, $3)`,
      [w.team, `mcp__${w.connector.name.replace(/-/g, "_")}__*`, w.owner.id],
    );
    expect((await callTool(w, { tool: "get_issue" })).json).toMatchObject({
      decision: "deny",
      code: "team_deny_rule",
    });
  });

  it("denies writes in auto mode and in scheduled runs (never prompts)", async () => {
    const w = await world();
    await fx.admin.query(`UPDATE runs SET approval_mode = 'auto' WHERE id = $1`, [w.runId]);
    expect((await callTool(w, { tool: "create_issue" })).json).toMatchObject({
      decision: "deny",
      code: "mode_auto_not_allowlisted",
    });
  });
});

describe("Gate 2: an MCP write runs only with a valid signed approval", () => {
  let w: World;
  const input = { q: "create the ticket" };
  const tool = () => piName(w.connector.name, "create_issue");
  const write = (body: Body = {}) =>
    callTool(w, { tool: "create_issue", arguments: input, ...body });

  beforeEach(async () => {
    w = await world();
  });

  it("refuses an unsigned call (a tampered kobe-policy skipped the approval)", async () => {
    const res = await write();
    expect(res.json).toMatchObject({
      decision: "deny",
      code: "risk_write",
      approval_failure: "no_approval",
    });
    const [row] = await auditRows(w.team);
    expect(row?.target).toMatchObject({
      decision: "denied",
      reason: "risk_write",
      approvalFailure: "no_approval",
      risk: "write",
    });
  });

  it("allows the call with a valid signed approval, records it, and only once", async () => {
    const token = await allowApproval(fx.admin, {
      teamId: w.team,
      runId: w.runId,
      threadId: w.threadId,
      userId: w.owner.id,
      tool: tool(),
      input,
      key: KEYRING.current,
    });
    const first = await write();
    expect(first.json).toMatchObject({
      decision: "allow",
      reason: "approval_granted",
      approval_id: token.approvalId,
      input_sha256: digest(input),
    });
    const second = await write();
    // Consumed: nothing usable is left for this run, tool and input.
    expect(second.json).toMatchObject({ decision: "deny", approval_failure: "no_approval" });
    // Naming the consumed approval's tool call explicitly does not revive it.
    const named = await write({ tool_call_id: token.toolCallId });
    expect(named.json).toMatchObject({ decision: "deny", approval_failure: "not_consumable" });
    const rows = await auditRows(w.team);
    expect(rows.map((r) => [r.target.decision, r.target.reason, r.target.approvalId])).toEqual([
      ["allowed", "approval_granted", token.approvalId],
      ["denied", "risk_write", undefined],
      ["denied", "risk_write", undefined],
    ]);
  });

  it("refuses a forged signature", async () => {
    await allowApproval(fx.admin, {
      teamId: w.team,
      runId: w.runId,
      threadId: w.threadId,
      userId: w.owner.id,
      tool: tool(),
      input,
      key: FORGED,
    });
    expect((await write()).json).toMatchObject({ decision: "deny", approval_failure: "bad_mac" });
  });

  it("refuses an approval replayed for a changed input", async () => {
    const token = await allowApproval(fx.admin, {
      teamId: w.team,
      runId: w.runId,
      threadId: w.threadId,
      userId: w.owner.id,
      tool: tool(),
      input,
      key: KEYRING.current,
    });
    const changed = { q: "something else" };
    // Found by input: nothing approved matches the changed input.
    expect((await write({ arguments: changed })).json).toMatchObject({
      decision: "deny",
      approval_failure: "no_approval",
    });
    // Named by tool call id: the MAC over the changed input does not verify.
    expect(
      (await write({ arguments: changed, tool_call_id: token.toolCallId })).json,
    ).toMatchObject({ decision: "deny", approval_failure: "bad_mac" });
  });

  it("refuses an expired approval", async () => {
    await allowApproval(fx.admin, {
      teamId: w.team,
      runId: w.runId,
      threadId: w.threadId,
      userId: w.owner.id,
      tool: tool(),
      input,
      key: KEYRING.current,
      now: new Date(Date.now() - 30 * 60_000),
    });
    expect((await write()).json).toMatchObject({ decision: "deny", approval_failure: "expired" });
  });

  it("refuses an approval of another tool of the same connector (delete with create's token)", async () => {
    await allowApproval(fx.admin, {
      teamId: w.team,
      runId: w.runId,
      threadId: w.threadId,
      userId: w.owner.id,
      tool: tool(),
      input,
      key: KEYRING.current,
    });
    const res = await callTool(w, { tool: "delete_issue", arguments: input });
    expect(res.json).toMatchObject({
      decision: "deny",
      code: "risk_destructive",
      approval_failure: "no_approval",
    });
  });

  it("never reaches another user's approval in the same team, even by naming its tool call", async () => {
    const peer = await fx.person(`p${randomUUID().slice(0, 4)}`);
    await fx.addMember(w.team, peer);
    const peerRun = await fx.run(w.team, peer);
    const peerSandbox = randomUUID();
    const peerThread = await leaseRun(fx.admin, w.team, peerRun, peer.id, peerSandbox);
    const peers = await allowApproval(fx.admin, {
      teamId: w.team,
      runId: peerRun,
      threadId: peerThread,
      userId: peer.id,
      tool: tool(),
      input,
      key: KEYRING.current,
    });
    // w's sandbox names the peer's thread: not its own run → no run at all.
    expect((await write({ thread_id: peerThread })).json).toMatchObject({
      decision: "deny",
      code: "run_not_active",
    });
    // w's own run, the peer's tool call id: the verifier looks only inside w's run.
    expect((await write({ tool_call_id: peers.toolCallId })).json).toMatchObject({
      decision: "deny",
      approval_failure: "no_approval",
    });
  });

  it("refuses an approval of another run (replayed across runs)", async () => {
    const other = await world();
    await allowApproval(fx.admin, {
      teamId: other.team,
      runId: other.runId,
      threadId: other.threadId,
      userId: other.owner.id,
      tool: tool(),
      input,
      key: KEYRING.current,
    });
    expect((await write()).json).toMatchObject({
      decision: "deny",
      approval_failure: "no_approval",
    });
  });

  it("refuses everything that needs approval while the deny-by-default stub is wired", async () => {
    const catalog = createDbMcpCatalog(fx.db);
    const stub = internalApp(
      createMcpService({
        db: fx.db,
        engine: createPolicyEngine({
          rules: createDbRuleSource(fx.db),
          registry: createToolRegistry(catalog),
          connectors: catalog,
        }),
        runContext: createDbRunContextSource(),
        approvals: DENY_UNVERIFIED_APPROVALS,
      }),
    );
    await allowApproval(fx.admin, {
      teamId: w.team,
      runId: w.runId,
      threadId: w.threadId,
      userId: w.owner.id,
      tool: tool(),
      input,
      key: KEYRING.current,
    });
    const res = await callTool(w, { tool: "create_issue", arguments: input }, w.token, stub);
    expect(res.json).toMatchObject({ decision: "deny", approval_failure: "unavailable" });
    // Reads are not affected by the stub.
    expect((await callTool(w, { tool: "get_issue" }, w.token, stub)).json).toMatchObject({
      decision: "allow",
    });
  });
});

describe("audit volume", () => {
  it("throttles audit rows of denied calls per sandbox (a looping agent cannot flood the chain)", async () => {
    const w = await world();
    for (let i = 0; i < 30; i++) await callTool(w, { tool: "exfiltrate" });
    const rows = await auditRows(w.team);
    expect(rows.length).toBeGreaterThanOrEqual(20);
    expect(rows.length).toBeLessThan(25);
  });
});

describe("MCP catalog (the engine's registry and connector state)", () => {
  it("resolves a pinned tool by its Pi name with risk from its annotations", async () => {
    const w = await world();
    const catalog = createDbMcpCatalog(fx.db);
    expect(await catalog.resolve(w.team, piName(w.connector.name, "create_issue"))).toEqual({
      name: piName(w.connector.name, "create_issue"),
      source: "mcp",
      connector_id: w.connector.id,
      risk: "write",
      open_world: true,
      scope: "external",
    });
    expect((await catalog.resolve(w.team, piName(w.connector.name, "delete_issue")))?.risk).toBe(
      "destructive",
    );
    expect(await catalog.resolve(w.team, piName(w.connector.name, "nope"))).toBeUndefined();
    expect(await catalog.resolve(w.team, "mcp__unknown_server__x")).toBeUndefined();
  });

  it("reports enablement, exposure and drifted tools per team", async () => {
    const w = await world({ exposure: "read_only" });
    const catalog = createDbMcpCatalog(fx.db);
    expect(await catalog.get(w.team, w.connector.id)).toEqual({
      enabled: true,
      exposure: "read_only",
      enabled_tools: [],
      drifted_tools: [piName(w.connector.name, "rename_issue")],
    });
    const other = await world();
    expect(await catalog.get(other.team, w.connector.id)).toBeUndefined();
  });
});
