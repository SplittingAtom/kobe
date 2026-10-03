import { randomUUID } from "node:crypto";
import type { ApprovalRecord, ApprovalStore, ApprovalToken, JsonObject } from "@kobe/protocol";
import { signApproval, type ApprovalKey } from "@kobe/protocol/node";
import type { ApprovalTokenSource } from "../mcp/approvals.js";

// In-memory stand-in for KOBE-37's approvals (tests only): signs with the reference HMAC and keeps
// rows with status, `input_hmac`, run state and single-use consumption like the protocol's
// `ApprovalStore` contract describes.

export const APPROVAL_KEY: ApprovalKey = { kid: "k1", secret: new Uint8Array(32).fill(7) };
export const OTHER_KEY: ApprovalKey = { kid: "k1", secret: new Uint8Array(32).fill(9) };

interface Row {
  record: ApprovalRecord;
  token: ApprovalToken;
  tool: string;
  consumed: boolean;
}

export class MemoryApprovals implements ApprovalStore, ApprovalTokenSource {
  private readonly rows: Row[] = [];
  /** Runs considered active (`running` / `waiting_approval`). */
  readonly activeRuns = new Set<string>();
  consumeCalls = 0;

  /** An `allowed` approval signed for exactly this call (optionally with another key / time). */
  allow(call: {
    teamId: string;
    runId: string;
    tool: string;
    input: JsonObject;
    toolCallId?: string;
    key?: ApprovalKey;
    now?: Date;
  }): ApprovalToken {
    const token = signApproval({
      key: call.key ?? APPROVAL_KEY,
      approval_id: randomUUID(),
      team_id: call.teamId,
      run_id: call.runId,
      tool_call_id: call.toolCallId ?? `toolu_${randomUUID().slice(0, 8)}`,
      tool: call.tool,
      input: call.input,
      now: call.now ?? new Date(),
    });
    this.add(token, call.tool);
    return token;
  }

  /** Stores a token as-is (forged or tampered ones included), status `allowed`. */
  add(token: ApprovalToken, tool = token.tool, status: ApprovalRecord["status"] = "allowed"): void {
    this.rows.push({
      token,
      tool,
      consumed: false,
      record: {
        approval_id: token.approval_id,
        team_id: token.team_id,
        run_id: token.run_id,
        tool_call_id: token.tool_call_id,
        status,
        input_hmac: token.mac,
        run_active: true,
      },
    });
  }

  candidates(query: Parameters<ApprovalTokenSource["candidates"]>[0]) {
    return Promise.resolve(
      this.rows
        .filter(
          (r) =>
            r.record.team_id === query.teamId &&
            r.record.run_id === query.runId &&
            r.tool === query.tool &&
            r.record.status === "allowed" &&
            (query.toolCallId === undefined || r.record.tool_call_id === query.toolCallId),
        )
        .reverse()
        .slice(0, query.limit)
        .map((r) => r.token),
    );
  }

  load(teamId: string, approvalId: string) {
    const row = this.rows.find(
      (r) => r.record.team_id === teamId && r.record.approval_id === approvalId,
    );
    return Promise.resolve(
      row ? { ...row.record, run_active: this.activeRuns.has(row.record.run_id) } : undefined,
    );
  }

  consume(teamId: string, approvalId: string) {
    this.consumeCalls += 1;
    const row = this.rows.find(
      (r) => r.record.team_id === teamId && r.record.approval_id === approvalId,
    );
    if (
      !row ||
      row.consumed ||
      row.record.status !== "allowed" ||
      !this.activeRuns.has(row.record.run_id)
    ) {
      return Promise.resolve(false);
    }
    row.consumed = true;
    return Promise.resolve(true);
  }
}
