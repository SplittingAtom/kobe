import {
  APPROVAL_MAC_ALGORITHM,
  APPROVAL_TOKEN_VERSION,
  approvalTokenSchema,
  type ApprovalRecord,
  type ApprovalResolutionCause,
  type ApprovalStatus,
  type ApprovalToken,
  type PolicyReason,
  type RiskClass,
} from "@kobe/protocol";
import { sql, type KobeTx } from "@kobe/db";

/**
 * `approvals` rows (KOBE-37). Everything runs inside the caller's `withTeam` transaction with
 * explicit `team_id` predicates (RLS is the wall; the predicate leads the index).
 */

export interface ApprovalRow {
  readonly id: string;
  readonly teamId: string;
  readonly runId: string;
  readonly threadId: string;
  readonly userId: string;
  readonly connectionId: string;
  readonly toolCallId: string;
  readonly tool: string;
  readonly inputCanonical: string;
  readonly risk: RiskClass;
  readonly reasons: readonly PolicyReason[];
  readonly status: ApprovalStatus;
  readonly cause: ApprovalResolutionCause | null;
  readonly decidedBy: string | null;
  readonly decidedAt: Date | null;
  readonly expiresAt: Date;
  readonly createdAt: Date;
  readonly tokenKid: string | null;
  readonly tokenExpiresAt: Date | null;
  readonly inputHmac: string | null;
  readonly consumedAt: Date | null;
  readonly remembered: boolean;
}

type Raw = {
  id: string;
  team_id: string;
  run_id: string;
  thread_id: string;
  user_id: string;
  connection_id: string;
  tool_call_id: string;
  tool: string;
  input_canonical: string;
  risk: RiskClass;
  reasons: PolicyReason[];
  status: ApprovalStatus;
  cause: ApprovalResolutionCause | null;
  decided_by: string | null;
  decided_at: Date | string | null;
  expires_at: Date | string;
  created_at: Date | string;
  token_kid: string | null;
  token_expires_at: Date | string | null;
  input_hmac: string | null;
  consumed_at: Date | string | null;
  remembered: boolean;
};

const date = (v: Date | string): Date => (v instanceof Date ? v : new Date(v));
const maybeDate = (v: Date | string | null): Date | null => (v === null ? null : date(v));

function fromRaw(r: Raw): ApprovalRow {
  return {
    id: r.id,
    teamId: r.team_id,
    runId: r.run_id,
    threadId: r.thread_id,
    userId: r.user_id,
    connectionId: r.connection_id,
    toolCallId: r.tool_call_id,
    tool: r.tool,
    inputCanonical: r.input_canonical,
    risk: r.risk,
    reasons: r.reasons,
    status: r.status,
    cause: r.cause,
    decidedBy: r.decided_by,
    decidedAt: maybeDate(r.decided_at),
    expiresAt: date(r.expires_at),
    createdAt: date(r.created_at),
    tokenKid: r.token_kid,
    tokenExpiresAt: maybeDate(r.token_expires_at),
    inputHmac: r.input_hmac,
    consumedAt: maybeDate(r.consumed_at),
    remembered: r.remembered,
  };
}

const SELECT = sql`
  SELECT id, team_id, run_id, thread_id, user_id, connection_id, tool_call_id, tool, input_canonical, risk,
         reasons, status, cause, decided_by, decided_at, expires_at, created_at, token_kid,
         token_expires_at, input_hmac, consumed_at, remembered
    FROM approvals`;

export async function loadApproval(
  tx: KobeTx,
  teamId: string,
  approvalId: string,
  options: { readonly lock?: boolean } = {},
): Promise<ApprovalRow | undefined> {
  const res = await tx.execute<Raw>(sql`${SELECT}
     WHERE team_id = ${teamId} AND id = ${approvalId}
     ${options.lock ? sql`FOR UPDATE` : sql``}`);
  const row = res.rows[0];
  return row ? fromRaw(row) : undefined;
}

export async function loadApprovalForCall(
  tx: KobeTx,
  teamId: string,
  runId: string,
  toolCallId: string,
): Promise<ApprovalRow | undefined> {
  const res = await tx.execute<Raw>(sql`${SELECT}
     WHERE team_id = ${teamId} AND run_id = ${runId} AND tool_call_id = ${toolCallId}`);
  const row = res.rows[0];
  return row ? fromRaw(row) : undefined;
}

/** A user's approvals in the team, newest first (`status` and `runId` narrow it). */
export async function listApprovals(
  tx: KobeTx,
  teamId: string,
  userId: string,
  filter: { readonly status?: ApprovalStatus; readonly runId?: string; readonly limit: number },
): Promise<ApprovalRow[]> {
  const res = await tx.execute<Raw>(sql`${SELECT}
     WHERE team_id = ${teamId} AND user_id = ${userId}
       ${filter.status === undefined ? sql`` : sql`AND status = ${filter.status}`}
       ${filter.runId === undefined ? sql`` : sql`AND run_id = ${filter.runId}`}
     ORDER BY created_at DESC, id
     LIMIT ${filter.limit}`);
  return res.rows.map(fromRaw);
}

export interface NewApproval {
  readonly teamId: string;
  readonly runId: string;
  readonly threadId: string;
  readonly userId: string;
  readonly connectionId: string;
  readonly toolCallId: string;
  readonly tool: string;
  readonly inputCanonical: string;
  readonly risk: RiskClass;
  readonly reasons: readonly PolicyReason[];
  readonly expiresAt: Date;
}

/** Inserts a pending approval; undefined when the run already has one for this tool call id. */
export async function insertPendingApproval(
  tx: KobeTx,
  a: NewApproval,
): Promise<string | undefined> {
  const res = await tx.execute<{ id: string }>(sql`
    INSERT INTO approvals (team_id, run_id, thread_id, user_id, connection_id, tool_call_id, tool,
                           input_canonical, risk, reasons, expires_at)
    VALUES (${a.teamId}, ${a.runId}, ${a.threadId}, ${a.userId}, ${a.connectionId},
            ${a.toolCallId}, ${a.tool},
            ${a.inputCanonical}, ${a.risk}, ${JSON.stringify(a.reasons)}::jsonb,
            ${a.expiresAt.toISOString()})
    ON CONFLICT ON CONSTRAINT approvals_tool_call_key DO NOTHING
    RETURNING id`);
  return res.rows[0]?.id;
}

/** Other approvals of the run still pending (the run stays `waiting_approval` while any is). */
export async function otherPendingCount(
  tx: KobeTx,
  teamId: string,
  runId: string,
  approvalId: string,
): Promise<number> {
  const res = await tx.execute<{ n: number }>(sql`
    SELECT count(*)::int AS n FROM approvals
     WHERE team_id = ${teamId} AND run_id = ${runId} AND status = 'pending' AND id <> ${approvalId}`);
  return res.rows[0]?.n ?? 0;
}

/** The signed token of an allowed row (the stored half of `approvalTokenSchema`). */
export function tokenOf(row: ApprovalRow): ApprovalToken | undefined {
  if (row.status !== "allowed" || !row.tokenKid || !row.tokenExpiresAt || !row.inputHmac) {
    return undefined;
  }
  const parsed = approvalTokenSchema.safeParse({
    v: APPROVAL_TOKEN_VERSION,
    alg: APPROVAL_MAC_ALGORITHM,
    kid: row.tokenKid,
    approval_id: row.id,
    team_id: row.teamId,
    run_id: row.runId,
    tool_call_id: row.toolCallId,
    tool: row.tool,
    expires_at: row.tokenExpiresAt.toISOString(),
    mac: row.inputHmac,
  });
  return parsed.success ? parsed.data : undefined;
}

/**
 * The state half of verification (`ApprovalStore` in @kobe/protocol approval.ts), inside a team
 * transaction. `consume` is the contract's single conditional statement.
 */
export async function loadApprovalRecord(
  tx: KobeTx,
  teamId: string,
  approvalId: string,
): Promise<ApprovalRecord | undefined> {
  const res = await tx.execute<{
    id: string;
    team_id: string;
    run_id: string;
    tool_call_id: string;
    status: ApprovalStatus;
    input_hmac: string | null;
    run_active: boolean;
  }>(sql`
    SELECT a.id, a.team_id, a.run_id, a.tool_call_id, a.status, a.input_hmac,
           r.status IN ('running', 'waiting_approval') AS run_active
      FROM approvals a JOIN runs r ON r.team_id = a.team_id AND r.id = a.run_id
     WHERE a.team_id = ${teamId} AND a.id = ${approvalId}`);
  const r = res.rows[0];
  return r
    ? {
        approval_id: r.id,
        team_id: r.team_id,
        run_id: r.run_id,
        tool_call_id: r.tool_call_id,
        status: r.status,
        input_hmac: r.input_hmac,
        run_active: r.run_active,
      }
    : undefined;
}

export async function consumeApprovalInTx(
  tx: KobeTx,
  teamId: string,
  approvalId: string,
): Promise<boolean> {
  const res = await tx.execute<{ id: string }>(sql`
    UPDATE approvals a SET consumed_at = now()
     WHERE a.team_id = ${teamId} AND a.id = ${approvalId}
       AND a.consumed_at IS NULL AND a.status = 'allowed'
       AND EXISTS (SELECT 1 FROM runs r WHERE r.team_id = a.team_id AND r.id = a.run_id
                     AND r.status IN ('running', 'waiting_approval'))
    RETURNING a.id`);
  return res.rows.length === 1;
}
