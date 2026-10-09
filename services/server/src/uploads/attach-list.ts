import { UPLOAD_ATTACHMENT_ROOT, type SandboxAttachment } from "@kobe/protocol";
import { sql, type KobeTx } from "@kobe/db";
import { attachmentPaths } from "./attach-names.js";

type AttachedRow = {
  id: string;
  run_id: string;
  name: string;
  mime_type: string;
  size_bytes: string | number;
};

async function attachedRows(tx: KobeTx, teamId: string, threadId: string): Promise<AttachedRow[]> {
  const res = await tx.execute<AttachedRow>(sql`
    SELECT f.id, f.run_id, f.name, f.mime_type, f.size_bytes
      FROM files f
      JOIN runs r ON r.team_id = f.team_id AND r.id = f.run_id
     WHERE f.team_id = ${teamId} AND f.thread_id = ${threadId}
       AND f.kind = 'upload' AND f.run_id IS NOT NULL
     ORDER BY r.created_at, r.id, f.created_at, f.id`);
  return res.rows;
}

/**
 * The files attached to a run, as `run.start.attachments` (KOBE-144). Reads Postgres only (no
 * object store), so a queued run's start and a restarted run build the same list: the files of the
 * thread attached by runs up to this one fix each name (attach-names.ts).
 *
 * `native_media` is not set: the model catalog has no capability flag yet, and the agent passes
 * only what the server marks. Without the hint the agent lists the path.
 */
export async function listRunAttachments(
  tx: KobeTx,
  teamId: string,
  threadId: string,
  runId: string,
): Promise<SandboxAttachment[]> {
  const rows = await attachedRows(tx, teamId, threadId);
  const paths = attachmentPaths(threadId, rows);
  const out: SandboxAttachment[] = [];
  for (const row of rows) {
    if (row.run_id !== runId) continue;
    const rel = paths.get(row.id);
    if (rel === undefined) continue;
    out.push({
      path: `${UPLOAD_ATTACHMENT_ROOT}/${rel.slice("uploads/".length)}`,
      mime_type: row.mime_type,
      name: row.name,
      size_bytes: Number(row.size_bytes),
    });
  }
  return out;
}

/** The workspace path (relative) of each file attached in a thread, by file id. */
export async function threadAttachmentPaths(
  tx: KobeTx,
  teamId: string,
  threadId: string,
): Promise<ReadonlyMap<string, string>> {
  return attachmentPaths(threadId, await attachedRows(tx, teamId, threadId));
}
