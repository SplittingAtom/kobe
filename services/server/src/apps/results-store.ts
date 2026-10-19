import { randomUUID } from "node:crypto";
import { Readable } from "node:stream";
import {
  APP_RESULT_INLINE_MAX_BYTES,
  APP_RESULT_MAX_BYTES,
  sql,
  threadAppResults,
  withTeam,
  type KobeDb,
  type KobeTx,
  type ThreadAppResultStorage,
} from "@kobe/db";
import { logger } from "../logger.js";
import { threadKey, type BlobStore } from "../retention/blobs.js";
import { teamStorageAllows } from "../uploads/quota.js";
import type { CaptureClaims } from "./capture-ticket.js";

/**
 * Stores an MCP App result mcp-proxy captured (KOBE-438, spec MA10) under a verified capture
 * ticket: up to 256 KiB inline, up to 4 MiB in the thread's own S3 tree, larger (or over the
 * team's storage quota, D26, or without object storage) as `too_large`, so the card renders as
 * text and says why. The row is unclaimed until the run's `tool.result` claims it (`claim.ts`).
 * Only while the ticket's run is still active in the ticket's thread.
 *
 * Blob writes copy artifacts' order (`artifacts/put.ts`): queue the key for deletion, upload,
 * then the row and the queue entry's removal in one transaction; a refusal deletes the upload.
 */
export interface AppResultStoreDeps {
  readonly db: KobeDb;
  readonly blobs: BlobStore | undefined;
  readonly defaultQuotaBytes: number;
}

export type StoreOutcome =
  | { readonly ok: true; readonly id: string; readonly storage: ThreadAppResultStorage }
  | { readonly ok: false; readonly code: "run_not_active" | "too_many_unclaimed" };

/**
 * Unclaimed results one run may hold (review MEDIUM-1): a run whose calls never get claimed (Pi
 * changed the input, a replay) cannot fill the team's quota before it ends and they are dropped.
 */
export const MAX_UNCLAIMED_PER_RUN = 20;

const PENDING_GRACE = sql.raw(`interval '1 hour'`);

async function unclaimed(tx: KobeTx, claims: CaptureClaims): Promise<number> {
  const res = await tx.execute<{ n: number }>(sql`
    SELECT count(*)::int AS n FROM thread_app_results
     WHERE team_id = ${claims.teamId} AND run_id = ${claims.runId}
       AND tool_call_id IS NULL AND entry_id IS NULL`);
  return res.rows[0]?.n ?? 0;
}

/**
 * The run, locked (KOBE-439 review LOW-A, LOW-B): a run end waits for this store to commit, so its
 * cleanup (0160) sees the row; a store that waited on an ended run finds it inactive and refuses;
 * and reports of one run are serialised, so the unclaimed cap is exact.
 */
async function runActive(tx: KobeTx, claims: CaptureClaims): Promise<boolean> {
  const res = await tx.execute<{ status: string }>(sql`
    SELECT status FROM runs
     WHERE team_id = ${claims.teamId} AND id = ${claims.runId} AND thread_id = ${claims.threadId}
     FOR UPDATE`);
  const status = res.rows[0]?.status;
  return status === "running" || status === "waiting_approval";
}

function rowFor(
  claims: CaptureClaims,
  id: string,
  storage: ThreadAppResultStorage,
  bytes: number,
  input: Record<string, unknown>,
  content: { result?: Record<string, unknown>; blobRef?: string } = {},
): typeof threadAppResults.$inferInsert {
  return {
    teamId: claims.teamId,
    id,
    threadId: claims.threadId,
    runId: claims.runId,
    piName: claims.piName,
    inputSha256: claims.inputSha256,
    connectorId: claims.connectorId,
    tool: claims.tool,
    templateUri: claims.templateUri,
    templateSha256: claims.templateSha256,
    appId: claims.appId,
    input,
    storage,
    result: content.result ?? null,
    blobRef: content.blobRef ?? null,
    bytes,
  };
}

/** The result's key in the thread's tree: derived here, never named by anyone else. */
export function appResultBlobKey(prefix: string, claims: CaptureClaims, id: string): string {
  return `${prefix}teams/${claims.teamId}/threads/${claims.threadId}/apps/${id}`;
}

export async function storeCapturedResult(
  deps: AppResultStoreDeps,
  claims: CaptureClaims,
  input: Record<string, unknown>,
  result: Record<string, unknown>,
): Promise<StoreOutcome> {
  const json = JSON.stringify(result);
  const bytes = Buffer.byteLength(json, "utf8");
  const id = randomUUID();
  const write = (
    storage: ThreadAppResultStorage,
    content?: { result?: Record<string, unknown>; blobRef?: string },
  ) =>
    withTeam(deps.db, claims.teamId, async (tx) => {
      if (!(await runActive(tx, claims))) return false;
      if ((await unclaimed(tx, claims)) >= MAX_UNCLAIMED_PER_RUN) return "capped" as const;
      // Stored bytes count against the team's quota (D26); a refusal keeps the text card.
      const fits =
        storage === "too_large" ||
        (await teamStorageAllows(tx, claims.teamId, deps.defaultQuotaBytes, bytes));
      const kept = fits ? storage : "too_large";
      await tx
        .insert(threadAppResults)
        .values(rowFor(claims, id, kept, bytes, input, kept === storage ? content : {}));
      if (content?.blobRef !== undefined && kept === storage) {
        await tx.execute(sql`
          DELETE FROM retention_blob_deletions
           WHERE team_id = ${claims.teamId} AND key = ${content.blobRef}`);
      }
      return kept;
    });

  const outcome = (kept: ThreadAppResultStorage | false | "capped"): StoreOutcome =>
    kept === false
      ? { ok: false, code: "run_not_active" }
      : kept === "capped"
        ? { ok: false, code: "too_many_unclaimed" }
        : { ok: true, id, storage: kept };

  if (bytes <= APP_RESULT_INLINE_MAX_BYTES) {
    const kept = await write("inline", { result });
    return outcome(kept);
  }
  const blobs = deps.blobs;
  const key = blobs ? appResultBlobKey(blobs.prefix, claims, id) : undefined;
  if (
    bytes > APP_RESULT_MAX_BYTES ||
    !blobs ||
    key === undefined ||
    !threadKey(blobs.prefix, claims.teamId, claims.threadId, key)
  ) {
    const kept = await write("too_large");
    return outcome(kept);
  }
  try {
    await withTeam(deps.db, claims.teamId, (tx) =>
      tx.execute(sql`
        INSERT INTO retention_blob_deletions (team_id, key, thread_id, owner_user_id, enqueued_at)
        VALUES (${claims.teamId}, ${key}, ${claims.threadId}, ${claims.userId}, now() + ${PENDING_GRACE})
        ON CONFLICT (team_id, key) DO NOTHING`),
    );
    await blobs.objects.put(key, Readable.from([Buffer.from(json, "utf8")]), bytes);
  } catch (err) {
    logger.error({ err, team_id: claims.teamId }, "app result upload failed; kept as text only");
    const kept = await write("too_large");
    return outcome(kept);
  }
  const kept = await write("blob", { blobRef: key });
  if (kept !== "blob") {
    try {
      await blobs.objects.delete([key]);
    } catch (err) {
      logger.warn({ err }, "app result: could not delete an unused upload");
    }
  }
  return outcome(kept);
}
