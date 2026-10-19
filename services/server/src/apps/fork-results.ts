import { randomUUID } from "node:crypto";
import { sql, threadAppResults, type KobeTx, type ThreadAppResultStorage } from "@kobe/db";
import { storageLimit, storageUsed } from "../uploads/quota.js";

/**
 * A fork copies the MCP App results of the entries it copies (KOBE-438, spec MA10, D18): claimed
 * results whose prompt entry is on the copied path, and app cards (MA-6) that are on it. A copy
 * has no run (runs are not copied) and is placed by (prompt entry, tool call); a result stored in
 * S3 is copied into the fork's own tree first (`forkThread`, outside the transaction).
 *
 * Only results whose tool call is on the copied path (review LOW-7): a fork at the prompt does
 * not copy results it cannot place. Copies count toward the team's quota (D26): when they do not
 * fit, they are kept as text (`too_large`, no bytes copied).
 */

/** A copied entry: its id and Pi payload. */
interface PathEntry {
  readonly entryId: string;
  readonly payload: Record<string, unknown>;
}

/** The tool call ids of the path's assistant messages. */
function toolCallsOn(path: readonly PathEntry[]): Set<string> {
  const ids = new Set<string>();
  for (const e of path) {
    const message = (e.payload as { message?: { content?: unknown } }).message;
    if (!Array.isArray(message?.content)) continue;
    for (const part of message.content as unknown[]) {
      const p = part as { type?: unknown; id?: unknown } | null;
      if (p?.type === "toolCall" && typeof p.id === "string") ids.add(p.id);
    }
  }
  return ids;
}
export interface AppCopy {
  readonly sourceId: string;
  readonly newId: string;
  readonly toolCallId: string | null;
  readonly promptEntryId: string | null;
  readonly entryId: string | null;
  readonly connectorId: string;
  readonly tool: string;
  readonly templateUri: string;
  readonly templateSha256: string;
  readonly appId: string;
  readonly storage: ThreadAppResultStorage;
  readonly input: Record<string, unknown> | null;
  readonly result: Record<string, unknown> | null;
  readonly blobRef: string | null;
  readonly bytes: number;
}

export async function planAppCopies(
  tx: KobeTx,
  teamId: string,
  sourceThreadId: string,
  path: readonly PathEntry[],
  quotaDefaultBytes: number | undefined,
): Promise<AppCopy[]> {
  const pathEntryIds = path.map((e) => e.entryId);
  if (pathEntryIds.length === 0) return [];
  const calls = toolCallsOn(path);
  const ids = sql.join(
    pathEntryIds.map((id) => sql`${id}`),
    sql`, `,
  );
  const res = await tx.execute<{
    id: string;
    tool_call_id: string | null;
    prompt_entry_id: string | null;
    entry_id: string | null;
    connector_id: string;
    tool: string;
    template_uri: string;
    template_sha256: string;
    app_id: string;
    storage: ThreadAppResultStorage;
    input: Record<string, unknown> | null;
    result: Record<string, unknown> | null;
    blob_ref: string | null;
    bytes: string | number;
  }>(sql`
    SELECT a.id, a.tool_call_id, COALESCE(a.prompt_entry_id, r.user_entry_id) AS prompt_entry_id,
           a.entry_id, a.connector_id, a.tool, a.template_uri, a.template_sha256, a.app_id,
           a.storage, a.input, a.result, a.blob_ref, a.bytes
      FROM thread_app_results a
      LEFT JOIN runs r ON r.team_id = a.team_id AND r.id = a.run_id
     WHERE a.team_id = ${teamId} AND a.thread_id = ${sourceThreadId}
       AND ((a.tool_call_id IS NOT NULL
             AND COALESCE(a.prompt_entry_id, r.user_entry_id) IN (${ids}))
         OR a.entry_id IN (${ids}))
     ORDER BY a.created_at, a.id`);
  const rows = res.rows.filter((r) => r.entry_id !== null || calls.has(r.tool_call_id ?? ""));
  const stored = rows.filter((r) => r.storage !== "too_large");
  const bytes = stored.reduce((n, r) => n + Number(r.bytes), 0);
  const fits =
    bytes === 0 ||
    quotaDefaultBytes === undefined ||
    (await storageUsed(tx, teamId)) + bytes <= (await storageLimit(tx, teamId, quotaDefaultBytes));
  return rows.map((r) => ({
    sourceId: r.id,
    newId: randomUUID(),
    toolCallId: r.tool_call_id,
    promptEntryId: r.prompt_entry_id,
    entryId: r.entry_id,
    connectorId: r.connector_id,
    tool: r.tool,
    templateUri: r.template_uri,
    templateSha256: r.template_sha256,
    appId: r.app_id,
    input: r.input,
    storage: fits ? r.storage : "too_large",
    result: fits ? r.result : null,
    blobRef: fits ? r.blob_ref : null,
    bytes: Number(r.bytes),
  }));
}

/** The fork's own key for a copied result. */
export function forkedAppResultKey(
  prefix: string,
  teamId: string,
  threadId: string,
  newId: string,
): string {
  return `${prefix}teams/${teamId}/threads/${threadId}/apps/${newId}`;
}

export async function storeAppCopies(
  tx: KobeTx,
  teamId: string,
  threadId: string,
  copies: readonly AppCopy[],
  blobKeys: ReadonlyMap<string, string>,
): Promise<void> {
  if (copies.length === 0) return;
  await tx.insert(threadAppResults).values(
    copies.map((c) => {
      const blobRef = c.storage === "blob" ? (blobKeys.get(c.newId) ?? null) : null;
      // A blob that could not be copied keeps the text card.
      const storage: ThreadAppResultStorage =
        c.storage === "blob" && blobRef === null ? "too_large" : c.storage;
      return {
        teamId,
        id: c.newId,
        threadId,
        toolCallId: c.toolCallId,
        promptEntryId: c.promptEntryId,
        entryId: c.entryId,
        connectorId: c.connectorId,
        tool: c.tool,
        templateUri: c.templateUri,
        templateSha256: c.templateSha256,
        appId: c.appId,
        input: c.input,
        storage,
        result: storage === "inline" ? c.result : null,
        blobRef,
        bytes: c.bytes,
      };
    }),
  );
}
