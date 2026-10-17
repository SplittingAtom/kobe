/**
 * Site console: what the server knows about backups (KOBE-291). `kobe backup` runs outside the
 * server, as a CLI or a Job with a read-only database role (docs/backup-restore.md), so no backup
 * is ever recorded; a restore is, as `platform.restore.completed` in the audit log (KOBE-11, KOBE-15).
 */
import type { ApiResult } from "../../../api/client";
import { listSiteAudit, type SiteAuditEvent } from "./audit";

export const RESTORE_ACTION = "platform.restore.completed";

export interface RestoreRecord {
  readonly restoredAt: string;
  /** When the restored backup was taken. */
  readonly backupCreatedAt: string | null;
  readonly operator: string | null;
  readonly tables: number | null;
  readonly rows: number | null;
  /** Head of the restored audit chain, verified by the restore. */
  readonly auditHead: { readonly seq: number; readonly hash: string } | null;
}

const text = (v: unknown): string | null => (typeof v === "string" ? v : null);
const count = (v: unknown): number | null =>
  typeof v === "number" && Number.isFinite(v) ? v : null;

export function restoreRecord(e: SiteAuditEvent): RestoreRecord {
  const t = e.target;
  const seq = count(t.auditHeadSeq);
  const hash = text(t.auditHeadHash);
  return {
    restoredAt: e.at,
    backupCreatedAt: text(t.backupCreatedAt),
    operator: text(t.operator),
    tables: count(t.tables),
    rows: count(t.rows),
    auditHead: seq !== null && hash !== null ? { seq, hash } : null,
  };
}

/** The latest restore recorded in the audit log, or null when the site was never restored. */
export async function getLastRestore(): Promise<ApiResult<RestoreRecord | null>> {
  const res = await listSiteAudit({ action: RESTORE_ACTION }, null, 1);
  if (!res.ok) return res;
  const latest = res.data.events[0];
  return { ...res, data: latest ? restoreRecord(latest) : null };
}
