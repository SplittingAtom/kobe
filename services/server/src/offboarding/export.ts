import { SYSTEM_ACTOR, sql, withTeam } from "@kobe/db";
import { currentAuditContext } from "../audit/context.js";
import { recordAudit } from "../audit/record.js";
import { zipChunks, type ZipSource } from "./zip.js";
import type { OffboardingContext } from "./types.js";

const PAGE = 200;

export interface OffboardedMember {
  readonly userId: string;
  readonly name: string | null;
  readonly retainUntil: string;
  readonly files: number;
  readonly bytes: number;
}

/** Members of the team whose workspace can still be exported (destroyed, inside the 30 days). */
export async function listOffboarded(
  ctx: OffboardingContext,
  teamId: string,
): Promise<OffboardedMember[]> {
  const rows = await withTeam(ctx.db, teamId, (tx) =>
    tx.execute<{
      user_id: string;
      name: string | null;
      retain_until: string | Date;
      live_files: string | null;
      live_bytes: string | null;
    }>(sql`
      SELECT s.user_id, u.name, s.retain_until, w.live_files, w.live_bytes
        FROM sandboxes s
        JOIN users u ON u.id = s.user_id
        LEFT JOIN workspace_sync w ON w.team_id = s.team_id AND w.user_id = s.user_id
       WHERE s.team_id = ${teamId} AND s.state = 'destroyed' AND s.retain_until > now()
       ORDER BY s.retain_until, s.user_id`),
  );
  return rows.rows.map((r) => ({
    userId: r.user_id,
    name: r.name,
    retainUntil: new Date(r.retain_until).toISOString(),
    files: Number(r.live_files ?? 0),
    bytes: Number(r.live_bytes ?? 0),
  }));
}

export type ExportStart =
  | {
      readonly kind: "ok";
      readonly files: number;
      readonly bytes: number;
      readonly chunks: AsyncGenerator<Uint8Array>;
    }
  | { readonly kind: "not_found" }
  | { readonly kind: "unavailable" };

/** Names that could escape the extraction folder are never written into the archive. */
export function safeZipPath(path: string): boolean {
  return (
    path.length > 0 &&
    !path.startsWith("/") &&
    !path.includes("\\") &&
    !path.includes("\0") &&
    !path.split("/").some((segment) => segment === ".." || segment === "." || segment === "")
  );
}

async function* sources(
  ctx: OffboardingContext,
  teamId: string,
  userId: string,
): AsyncGenerator<ZipSource> {
  const blobs = ctx.blobs;
  if (!blobs) return;
  let after = "";
  for (;;) {
    const page = await withTeam(ctx.db, teamId, (tx) =>
      tx.execute<{ path: string; blob_key: string; mtime_ms: string }>(sql`
        SELECT path, blob_key, mtime_ms FROM workspace_files
         WHERE team_id = ${teamId} AND user_id = ${userId} AND NOT deleted AND path > ${after}
         ORDER BY path LIMIT ${PAGE}`),
    );
    for (const file of page.rows) {
      if (!safeZipPath(file.path)) continue;
      const object = await blobs.objects.get(file.blob_key);
      if (!object) throw new Error(`workspace object for ${file.path} is missing`);
      yield { path: file.path, mtimeMs: Number(file.mtime_ms), body: object.body };
    }
    const last = page.rows.at(-1);
    if (!last || page.rows.length < PAGE) return;
    after = last.path;
  }
}

/**
 * Starts the zip export of an offboarded member's workspace for a team admin (D12, ac-2). Allowed
 * only while the member's sandbox is `destroyed` and `retain_until` is in the future; the download
 * is audited (`sandbox.export_downloaded`, counts only) before any byte leaves. The workspace is
 * read from the durable S3 copy (the volume itself is not mounted by anyone).
 */
export async function startExport(
  ctx: OffboardingContext,
  teamId: string,
  userId: string,
): Promise<ExportStart> {
  if (!ctx.blobs) return { kind: "unavailable" };
  const counts = await withTeam(ctx.db, teamId, async (tx) => {
    const due = await tx.execute<{ live_files: string | null; live_bytes: string | null }>(sql`
      SELECT w.live_files, w.live_bytes
        FROM sandboxes s
        LEFT JOIN workspace_sync w ON w.team_id = s.team_id AND w.user_id = s.user_id
       WHERE s.team_id = ${teamId} AND s.user_id = ${userId}
         AND s.state = 'destroyed' AND s.retain_until > now()`);
    const row = due.rows[0];
    if (!row) return undefined;
    const files = Number(row.live_files ?? 0);
    const bytes = Number(row.live_bytes ?? 0);
    await recordAudit(tx, {
      action: "sandbox.export_downloaded",
      actor: currentAuditContext()?.actor ?? SYSTEM_ACTOR,
      teamId,
      target: { userId, files, bytes },
    });
    return { files, bytes };
  });
  if (!counts) return { kind: "not_found" };
  return { kind: "ok", ...counts, chunks: zipChunks(sources(ctx, teamId, userId)) };
}
