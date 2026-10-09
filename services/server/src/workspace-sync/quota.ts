import { sql, type KobeTx } from "@kobe/db";
import { teamStorageAllows } from "../uploads/quota.js";
import type { WorkspaceOwner } from "./keys.js";

/**
 * Size limits and the quota seam (KOBE-27). Defaults come from the chart
 * (`sandbox.workspaceSync`); KOBE-53 replaces the check with D26's per-team storage quota
 * (S3 + volumes) by passing its own {@link QuotaCheck} — it runs inside the commit's transaction
 * (team-scoped), so it can read team totals.
 */
export interface WorkspaceLimits {
  /** Largest single file synced. */
  readonly maxFileBytes: number;
  /** Live bytes per workspace (defaults to the /workspace volume size). */
  readonly maxWorkspaceBytes: number;
  /** Live files per workspace. */
  readonly maxFiles: number;
  /** Manifest rows (live + tombstones) per workspace; default 2 × maxFiles. */
  readonly maxRows?: number;
  /** Uncommitted distinct contents a workspace may hold beyond its live files; default 10 000. */
  readonly maxUncommittedBlobs?: number;
  /** Bytes of held content (committed or not) + uploads in flight; default 2 × maxWorkspaceBytes. */
  readonly maxBlobBytes?: number;
}

export type ResolvedLimits = Required<WorkspaceLimits>;

export function resolveLimits(l: WorkspaceLimits): ResolvedLimits {
  return {
    ...l,
    maxRows: l.maxRows ?? 2 * l.maxFiles,
    maxUncommittedBlobs: l.maxUncommittedBlobs ?? 10_000,
    maxBlobBytes: l.maxBlobBytes ?? 2 * l.maxWorkspaceBytes,
  };
}

export interface QuotaRequest {
  readonly owner: WorkspaceOwner;
  /** Size of the file being written. */
  readonly fileBytes: number;
  /** Workspace totals if the write is applied. */
  readonly liveFiles: number;
  readonly liveBytes: number;
}

export type QuotaDecision =
  | { readonly ok: true }
  | {
      readonly ok: false;
      readonly code: "quota_exceeded" | "too_many_files";
      /** `sandbox.limit_exceeded` audit value. */
      readonly limit: "workspace_bytes" | "workspace_files" | "workspace_file_size";
    };

export type QuotaCheck = (tx: KobeTx, request: QuotaRequest) => Promise<QuotaDecision>;

/** The default check: the install's limits per workspace. */
export function limitsQuota(limits: WorkspaceLimits): QuotaCheck {
  return (_tx, r) => {
    if (r.fileBytes > limits.maxFileBytes) {
      return Promise.resolve({ ok: false, code: "quota_exceeded", limit: "workspace_file_size" });
    }
    if (r.liveFiles > limits.maxFiles) {
      return Promise.resolve({ ok: false, code: "too_many_files", limit: "workspace_files" });
    }
    if (r.liveBytes > limits.maxWorkspaceBytes) {
      return Promise.resolve({ ok: false, code: "quota_exceeded", limit: "workspace_bytes" });
    }
    return Promise.resolve({ ok: true });
  };
}

/**
 * Adds the team storage quota (KOBE-185) to a per-workspace check: a write that grows the
 * workspace past what the team may store is refused as `quota_exceeded` (`workspace_bytes` in the
 * audit), via the same {@link teamStorageAllows} uploads use, so the two serialize on one lock.
 * The delta is the workspace's new live bytes minus the committed ones (state is saved at the end
 * of the commit, so `workspace_sync.live_bytes` is still the old value here).
 */
export function withTeamStorage(inner: QuotaCheck, defaultBytes: number): QuotaCheck {
  return async (tx, r) => {
    const decision = await inner(tx, r);
    if (!decision.ok) return decision;
    const res = await tx.execute<{ live_bytes: string }>(sql`
      SELECT live_bytes FROM workspace_sync
       WHERE team_id = ${r.owner.teamId} AND user_id = ${r.owner.userId}`);
    const committed = Number(res.rows[0]?.live_bytes ?? 0);
    const allowed = await teamStorageAllows(
      tx,
      r.owner.teamId,
      defaultBytes,
      r.liveBytes - committed,
    );
    return allowed ? { ok: true } : { ok: false, code: "quota_exceeded", limit: "workspace_bytes" };
  };
}
