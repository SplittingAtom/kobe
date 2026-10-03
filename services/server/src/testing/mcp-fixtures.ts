import { createHash, randomUUID } from "node:crypto";
import type pg from "pg";
import { canonicalJson, mcpServerSegment, type JsonObject } from "@kobe/protocol";
import { signApproval, type ApprovalKey } from "@kobe/protocol/node";
import { signSessionToken } from "@kobe/session-token";
import type { PinnedTool } from "@kobe/db";

// MCP connector fixtures (tests only): an in-DB registry entry with a pinned snapshot, team
// enablement, run leases and mcp-proxy session tokens — the minimal model KOBE-59/60 will manage.

export const MCP_SESSION_KEY = "m".repeat(48);
export const WIRE_SESSION_KEY = "w".repeat(48);
export const INTERNAL_KEY = "i".repeat(40);

export interface ToolSpec {
  readonly name: string;
  readonly readOnly?: boolean;
  /** `false` → write; undefined (and not read-only) → destructive (D29). */
  readonly destructive?: boolean;
  readonly status?: PinnedTool["status"];
}

export function piName(connectorName: string, tool: string): string {
  return `mcp__${mcpServerSegment(connectorName)}__${tool.replace(/[^A-Za-z0-9_]/g, "_")}`;
}

export function pinnedTool(connectorName: string, spec: ToolSpec): PinnedTool {
  const description = `${spec.name} (pinned)`;
  const input_schema = { type: "object", properties: { q: { type: "string" } } };
  return {
    name: spec.name,
    pi_name: piName(connectorName, spec.name),
    description,
    input_schema,
    annotations: {
      ...(spec.readOnly ? { readOnlyHint: true } : {}),
      ...(spec.destructive === undefined ? {} : { destructiveHint: spec.destructive }),
    },
    sha256: createHash("sha256")
      .update(JSON.stringify([spec.name, description, input_schema]))
      .digest("hex"),
    status: spec.status ?? "pinned",
  };
}

export const STANDARD_TOOLS: readonly ToolSpec[] = [
  { name: "get_issue", readOnly: true },
  { name: "create_issue", destructive: false },
  { name: "delete_issue" },
  { name: "rename_issue", destructive: false, status: "drifted" },
];

/** Registers a connector (as the superuser: KOBE-59 owns the admin API). */
export async function registerConnector(
  admin: pg.Client,
  options: {
    name?: string;
    url?: string;
    tools?: readonly ToolSpec[];
    status?: "active" | "disabled";
    authKind?: "none" | "oauth" | "api_key";
  } = {},
): Promise<{ id: string; name: string; tools: PinnedTool[] }> {
  const name = options.name ?? `jira-${randomUUID().slice(0, 8)}`;
  const tools = (options.tools ?? STANDARD_TOOLS).map((t) => pinnedTool(name, t));
  const { rows } = await admin.query<{ id: string }>(
    `INSERT INTO connectors (name, url, status, auth_kind, tools_snapshot)
     VALUES ($1, $2, $3, $4, $5::jsonb) RETURNING id`,
    [
      name,
      options.url ?? "https://mcp.example.com/mcp",
      options.status ?? "active",
      options.authKind ?? "none",
      JSON.stringify(tools),
    ],
  );
  const id = rows[0]?.id;
  if (!id) throw new Error("connector insert returned nothing");
  return { id, name, tools };
}

export async function enableConnector(
  admin: pg.Client,
  teamId: string,
  connectorId: string,
  enabledBy: string,
  exposure: "read_only" | "all" | "custom" = "all",
  enabledTools: readonly string[] = [],
): Promise<void> {
  await admin.query(
    `INSERT INTO team_connectors (team_id, connector_id, exposure, enabled_tools, enabled_by)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (team_id, connector_id) DO UPDATE SET exposure = $3, enabled_tools = $4`,
    [teamId, connectorId, exposure, enabledTools, enabledBy],
  );
}

/** Leases a run to a sandbox, as the wire does when it delivers `run.start` (KOBE-24). */
export async function leaseRun(
  admin: pg.Client,
  teamId: string,
  runId: string,
  userId: string,
  sandboxId: string,
): Promise<string> {
  const { rows } = await admin.query<{ thread_id: string }>(
    `INSERT INTO sandbox_run_leases (team_id, run_id, user_id, thread_id, sandbox_id)
     SELECT team_id, id, $3, thread_id, $4 FROM runs WHERE team_id = $1 AND id = $2
     RETURNING thread_id`,
    [teamId, runId, userId, sandboxId],
  );
  const threadId = rows[0]?.thread_id;
  if (!threadId) throw new Error("lease insert returned nothing");
  return threadId;
}

export function mcpToken(
  claims: { sandboxId: string; teamId: string; userId: string },
  options: { audience?: "kobe.mcp-proxy" | "kobe.sandbox-wire"; key?: string; ttl?: number } = {},
): string {
  const now = Math.floor(Date.now() / 1000);
  return signSessionToken(
    {
      iss: "kobe-server",
      aud: options.audience ?? "kobe.mcp-proxy",
      sub: claims.sandboxId,
      team_id: claims.teamId,
      user_id: claims.userId,
      iat: now,
      exp: now + (options.ttl ?? 600),
      jti: `test-${randomUUID()}`,
    },
    options.key ?? MCP_SESSION_KEY,
  );
}

/**
 * An `allowed` approval row exactly as KOBE-37's decide path stores it (canonical input, token
 * kid/expiry, `input_hmac` = the MAC), signed with `key` (the install key, or a forger's). The row
 * goes in as the superuser; signing is the protocol reference HMAC.
 */
export async function allowApproval(
  admin: pg.Client,
  call: {
    teamId: string;
    runId: string;
    threadId: string;
    userId: string;
    tool: string;
    input: JsonObject;
    key: ApprovalKey;
    toolCallId?: string;
    now?: Date;
  },
): Promise<{ approvalId: string; toolCallId: string }> {
  const approvalId = randomUUID();
  const toolCallId = call.toolCallId ?? `toolu_${randomUUID().slice(0, 12)}`;
  const now = call.now ?? new Date();
  const token = signApproval({
    key: call.key,
    approval_id: approvalId,
    team_id: call.teamId,
    run_id: call.runId,
    tool_call_id: toolCallId,
    tool: call.tool,
    input: call.input,
    now,
  });
  await admin.query(
    `INSERT INTO approvals (team_id, id, run_id, thread_id, user_id, tool_call_id, tool,
       input_canonical, risk, reasons, status, cause, decided_by, decided_at, expires_at,
       token_kid, token_expires_at, input_hmac)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'write', '[]'::jsonb, 'allowed', 'user', $5, $9,
       $9::timestamptz + interval '1 hour', $10, $11, $12)`,
    [
      call.teamId,
      approvalId,
      call.runId,
      call.threadId,
      call.userId,
      toolCallId,
      call.tool,
      canonicalJson(call.input),
      now.toISOString(),
      token.kid,
      token.expires_at,
      token.mac,
    ],
  );
  return { approvalId, toolCallId };
}
