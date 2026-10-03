import type { KobeTx } from "@kobe/db";
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
