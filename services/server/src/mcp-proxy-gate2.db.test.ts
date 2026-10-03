import { randomUUID } from "node:crypto";
import type { AddressInfo } from "node:net";
import { serve, type ServerType } from "@hono/node-server";
import { pino } from "pino";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  DEFAULT_LIMITS,
  FakeUpstream,
  NO_GRANTS,
  createApp as createProxyApp,
  createLimiter,
  createPolicyServer,
  createUpstreamClient,
  type UpstreamClient,
} from "@kobe/mcp-proxy";
import { approvalKeyring } from "./approvals/index.js";
import { createInternalApp } from "./routes/internal.js";
import { EventStreamFixture, type Person } from "./testing/event-stream-fixture.js";
import {
  INTERNAL_KEY,
  MCP_SESSION_KEY,
  allowApproval,
  enableConnector,
  leaseRun,
  mcpToken,
  piName,
  registerConnector,
} from "./testing/mcp-fixtures.js";

/**
 * Gate 2 end to end across the process boundary (KOBE-58 + KOBE-37): "a sandbox with a tampered
 * kobe-policy extension still cannot execute an MCP write without a signed approval".
 *
 * The client here is a tampered sandbox: it never sends `policy.check` (kobe-policy bypassed) and
 * calls the **real MCP proxy app** directly with its session token. The proxy talks HTTP to the
 * **real server internal listener** (policy engine, KOBE-37 verifier over the `approvals` table,
 * audit) on a real Postgres, and forwards only allowed calls to a fake remote MCP server, which
 * records what it receives.
 */
const fx = new EventStreamFixture();
const KEYRING = approvalKeyring("g".repeat(48));
const upstreamServer = new FakeUpstream();
const live = new Set<string>();
let internal: ServerType;
let upstream: UpstreamClient;
let proxy: ReturnType<typeof createProxyApp>;

beforeAll(async () => {
  await fx.setup([{}], () => ({ sandboxWire: { sweep: false }, approvalKeys: KEYRING }));
  await upstreamServer.start();
  const app = createInternalApp({
    internalKey: INTERNAL_KEY,
    mcp: fx.replica(0).deps.mcp,
    auth: {
      db: fx.db,
      sessionKey: MCP_SESSION_KEY,
      liveness: { isLive: ({ sandboxId }) => Promise.resolve(live.has(sandboxId)) },
    },
  });
  internal = await new Promise<ServerType>((resolve) => {
    const s = serve({ fetch: app.fetch, port: 0, hostname: "127.0.0.1" }, () => resolve(s));
  });
  const { port } = internal.address() as AddressInfo;
  upstream = createUpstreamClient({
    policy: {
      allowInsecureHttp: true,
      allowedPorts: [Number(new URL(upstreamServer.url).port)],
      allowedInternalCidrs: ["127.0.0.0/8"],
      deniedCidrs: [],
    },
    maxResponseBytes: 1024 * 1024,
  });
  proxy = createProxyApp({
    sessionKey: MCP_SESSION_KEY,
    server: createPolicyServer({
      baseUrl: `http://127.0.0.1:${port}`,
      internalKey: INTERNAL_KEY,
      timeoutMs: 10_000,
    }),
    upstream,
    credentials: NO_GRANTS,
    limiter: createLimiter({
      burst: 1_000,
      perSecond: 100,
      callsPerSandbox: 8,
      maxConcurrentCalls: 64,
    }),
    limits: { ...DEFAULT_LIMITS, upstreamTimeoutMs: 10_000 },
    log: pino({ level: "silent" }),
  });
});

afterAll(async () => {
  await upstream.close();
  await upstreamServer.stop();
  await new Promise<void>((resolve) => internal.close(() => resolve()));
  await fx.teardown();
});

beforeEach(() => {
  upstreamServer.received.length = 0;
});

interface Sandbox {
  readonly team: string;
  readonly owner: Person;
  readonly sandboxId: string;
  readonly token: string;
  readonly runId: string;
  readonly threadId: string;
  readonly connectorId: string;
  readonly tool: string;
}

async function sandbox(): Promise<Sandbox> {
  const owner = await fx.person(`g${randomUUID().slice(0, 4)}`);
  const team = await fx.team(`gate2-${randomUUID().slice(0, 6)}`, owner);
  const sandboxId = randomUUID();
  live.add(sandboxId);
  const runId = await fx.run(team, owner);
  const threadId = await leaseRun(fx.admin, team, runId, owner.id, sandboxId);
  const connector = await registerConnector(fx.admin, { url: upstreamServer.url });
  await enableConnector(fx.admin, team, connector.id, owner.id, "all");
  return {
    team,
    owner,
    sandboxId,
    token: mcpToken({ sandboxId, teamId: team, userId: owner.id }),
    runId,
    threadId,
    connectorId: connector.id,
    tool: piName(connector.name, "create_issue"),
  };
}

let nextId = 1;
/** A tampered sandbox's direct `tools/call` to the proxy (no policy.check before it). */
async function callDirect(
  s: Sandbox,
  name: string,
  args: Record<string, unknown>,
  options: { toolCallId?: string; threadId?: string } = {},
) {
  const res = await proxy.request(`/v1/mcp/${s.connectorId}`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${s.token}`,
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      "kobe-thread-id": options.threadId ?? s.threadId,
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: nextId++,
      method: "tools/call",
      params: {
        name,
        arguments: args,
        ...(options.toolCallId ? { _meta: { "kobe.dev/tool_call_id": options.toolCallId } } : {}),
      },
    }),
  });
  expect(res.status).toBe(200);
  return (await res.json()) as { result?: { content: { text: string }[]; isError?: boolean } };
}

const writes = () => upstreamServer.calls().filter((c) => c.message.params);
const auditActions = async (team: string) => {
  const { rows } = await fx.admin.query<{ action: string; target: Record<string, unknown> }>(
    `SELECT action, target FROM audit_log WHERE team_id = $1
       AND action IN ('mcp.tool_call', 'approval.consumed', 'approval.rejected') ORDER BY seq`,
    [team],
  );
  return rows;
};

describe("Gate 2 through the real MCP proxy, kobe-policy bypassed", () => {
  const input = { title: "Disk full on db-1", priority: "p1" };

  it("refuses an MCP write without a signed approval; the remote server never sees it", async () => {
    const s = await sandbox();
    const out = await callDirect(s, "create_issue", input);
    expect(out.result?.isError).toBe(true);
    expect(out.result?.content[0]?.text).toMatch(/^Kobe denied this call/);
    expect(writes()).toEqual([]);
    expect((await auditActions(s.team)).at(-1)?.target).toMatchObject({
      decision: "denied",
      approvalFailure: "no_approval",
    });
  });

  it("runs the write exactly once with a valid signed approval", async () => {
    const s = await sandbox();
    const approval = await allowApproval(fx.admin, {
      teamId: s.team,
      runId: s.runId,
      threadId: s.threadId,
      userId: s.owner.id,
      tool: s.tool,
      input,
      key: KEYRING.current,
    });

    const first = await callDirect(s, "create_issue", input);
    expect(first.result?.isError).toBeUndefined();
    expect(first.result?.content[0]?.text).toBe(
      `create_issue:${JSON.stringify({ priority: "p1", title: "Disk full on db-1" })}`,
    );
    expect(writes().map((c) => c.message.params)).toEqual([
      { name: "create_issue", arguments: { priority: "p1", title: "Disk full on db-1" } },
    ]);

    // Replays: the same call again, and the same call naming the consumed approval's tool call.
    expect((await callDirect(s, "create_issue", input)).result?.isError).toBe(true);
    expect(
      (await callDirect(s, "create_issue", input, { toolCallId: approval.toolCallId })).result
        ?.isError,
    ).toBe(true);
    expect(writes()).toHaveLength(1);

    const audit = await auditActions(s.team);
    expect(audit.filter((a) => a.action === "approval.consumed")).toHaveLength(1);
    expect(audit.filter((a) => a.action === "mcp.tool_call").map((a) => a.target.decision)).toEqual(
      ["allowed", "denied", "denied"],
    );
    const consumed = await fx.admin.query<{ consumed_at: Date | null }>(
      `SELECT consumed_at FROM approvals WHERE team_id = $1 AND id = $2`,
      [s.team, approval.approvalId],
    );
    expect(consumed.rows[0]?.consumed_at).not.toBeNull();
  });

  it("refuses a forged signature, a changed input and an expired approval", async () => {
    const s = await sandbox();
    const forged = await allowApproval(fx.admin, {
      teamId: s.team,
      runId: s.runId,
      threadId: s.threadId,
      userId: s.owner.id,
      tool: s.tool,
      input,
      key: { kid: KEYRING.current.kid, secret: new Uint8Array(32).fill(1) },
    });
    expect((await callDirect(s, "create_issue", input)).result?.isError).toBe(true);
    expect(
      (await callDirect(s, "create_issue", input, { toolCallId: forged.toolCallId })).result
        ?.isError,
    ).toBe(true);

    const real = await allowApproval(fx.admin, {
      teamId: s.team,
      runId: s.runId,
      threadId: s.threadId,
      userId: s.owner.id,
      tool: s.tool,
      input: { ...input, title: "the approved title" },
      key: KEYRING.current,
      now: new Date(Date.now() - 30 * 60_000), // token lifetime is 10 minutes
    });
    expect(
      (await callDirect(s, "create_issue", { ...input, title: "the approved title" })).result
        ?.isError,
    ).toBe(true);
    expect(
      (
        await callDirect(
          s,
          "create_issue",
          { ...input, title: "changed after approval" },
          {
            toolCallId: real.toolCallId,
          },
        )
      ).result?.isError,
    ).toBe(true);
    expect(writes()).toEqual([]);
    const reasons = (await auditActions(s.team))
      .filter((a) => a.action === "approval.rejected")
      .map((a) => a.target.reason);
    expect(reasons).toEqual(expect.arrayContaining(["bad_mac", "expired"]));
  });

  it("cannot borrow another user's approval or run (thread and tool call id are checked)", async () => {
    const victim = await sandbox();
    const attacker = await sandbox();
    const approval = await allowApproval(fx.admin, {
      teamId: victim.team,
      runId: victim.runId,
      threadId: victim.threadId,
      userId: victim.owner.id,
      tool: victim.tool,
      input,
      key: KEYRING.current,
    });
    // The attacker's own connector id and token, the victim's thread and tool call id.
    const borrowed = await callDirect(attacker, "create_issue", input, {
      threadId: victim.threadId,
      toolCallId: approval.toolCallId,
    });
    expect(borrowed.result?.isError).toBe(true);
    const ownRun = await callDirect(attacker, "create_issue", input, {
      toolCallId: approval.toolCallId,
    });
    expect(ownRun.result?.isError).toBe(true);
    expect(writes()).toEqual([]);
    // The victim's approval is untouched and still works for the victim.
    expect((await callDirect(victim, "create_issue", input)).result?.isError).toBeUndefined();
    expect(writes()).toHaveLength(1);
  });

  it("a sibling run's laxer policy cannot stand in (review M1): auto and scheduled siblings", async () => {
    const s = await sandbox();
    // Thread B in the same sandbox: an auto run for which the team allow-listed the write (D32 auto allow-list), and a
    // scheduled run (always auto, D32). Thread A (s.threadId) is ask-on-write.
    const autoRun = await fx.run(s.team, s.owner);
    const autoThread = await leaseRun(fx.admin, s.team, autoRun, s.owner.id, s.sandboxId);
    await fx.admin.query(`UPDATE runs SET approval_mode = 'auto' WHERE id = $1`, [autoRun]);
    const schedRun = await fx.run(s.team, s.owner);
    const schedThread = await leaseRun(fx.admin, s.team, schedRun, s.owner.id, s.sandboxId);
    await fx.admin.query(`UPDATE runs SET trigger = 'schedule' WHERE id = $1`, [schedRun]);
    await fx.admin.query(
      `INSERT INTO tool_rules (team_id, scope, effect, tool_glob, created_by)
       VALUES ($1, 'team', 'allow', $3, $2)`,
      [s.team, s.owner.id, s.tool],
    );
    // The injected thread A names B's thread (or the scheduled one) to borrow its policy.
    for (const threadId of [autoThread, schedThread]) {
      const out = await callDirect(s, "create_issue", input, { threadId });
      expect(out.result?.isError, threadId).toBe(true);
    }
    expect((await callDirect(s, "create_issue", input)).result?.isError).toBe(true);
    expect(writes()).toEqual([]);

    // With the user's approval in thread A, the write runs (once) even while siblings are active.
    await allowApproval(fx.admin, {
      teamId: s.team,
      runId: s.runId,
      threadId: s.threadId,
      userId: s.owner.id,
      tool: s.tool,
      input,
      key: KEYRING.current,
    });
    expect((await callDirect(s, "create_issue", input)).result?.isError).toBeUndefined();
    expect(writes()).toHaveLength(1);
  });

  it("lets a read-only tool through without any approval", async () => {
    const s = await sandbox();
    const out = await callDirect(s, "get_issue", { id: "OPS-1" });
    expect(out.result?.isError).toBeUndefined();
    expect(upstreamServer.calls().map((c) => c.message.params)).toEqual([
      { name: "get_issue", arguments: { id: "OPS-1" } },
    ]);
  });
});
