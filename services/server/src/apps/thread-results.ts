import {
  and,
  connectors,
  desc,
  eq,
  inArray,
  isNotNull,
  or,
  runs,
  threadAppResults,
  type KobeDb,
  type KobeTx,
} from "@kobe/db";
import { appVisible } from "../connectors/visibility.js";
import { servedTemplateHash } from "../connectors/template-store.js";
import type { BlobStore } from "../retention/blobs.js";
import { createReadLimiter } from "../threads/entry-output.js";
import { readOffloadedJson } from "../threads/offloaded-body.js";
import { memberApps, type MemberApp } from "./catalog.js";

/**
 * How one viewer sees a thread's MCP App results (KOBE-438, spec MA10, T12): the live app when
 * they can open it now, acting as themselves, or the text card with the one-line reason:
 *
 * - `too_large`: the result was not stored (over 4 MiB, the team's quota, or no object storage);
 * - `template_changed`: the template drifted or was removed, or its approved hash is no longer
 *   the one the result was captured for, or the tool changed;
 * - `not_app_visible`: the tool is no longer visible to apps (MA6);
 * - `no_access`: the viewer cannot call the connector (no key, not enabled for the team).
 *
 * Break-glass readers (D10) never come here (their reader is the site console's text view).
 */
export const APP_TEXT_REASONS = [
  "too_large",
  "template_changed",
  "not_app_visible",
  "no_access",
] as const;
export type AppTextReason = (typeof APP_TEXT_REASONS)[number];

/** Most results one answer carries (newest kept). */
export const MAX_APP_RESULTS = 500;

export interface AppResultView {
  readonly result_ref: string;
  readonly run_id: string | null;
  readonly user_entry_id: string | null;
  readonly tool_call_id: string | null;
  readonly entry_id: string | null;
  readonly connector_id: string;
  readonly connector_name: string;
  readonly tool: string;
  readonly app_id: string;
  readonly template_sha256: string;
  readonly view: "app" | "text";
  /** A rail-launched card waiting for the thread's run to end (KOBE-440): no entry yet. */
  readonly queued: boolean;
  readonly reason?: AppTextReason;
  /** Only with `view: "app"`: what the frame needs. */
  readonly app?: { readonly title: string };
}

interface Row {
  readonly id: string;
  readonly runId: string | null;
  readonly toolCallId: string | null;
  readonly entryId: string | null;
  readonly connectorId: string;
  readonly tool: string;
  readonly templateUri: string;
  readonly templateSha256: string;
  readonly appId: string;
  readonly storage: string;
}

function decide(
  row: Row,
  live: MemberApp | undefined,
  served: string | undefined,
): { view: "app" } | { view: "text"; reason: AppTextReason } {
  if (row.storage === "too_large") return { view: "text", reason: "too_large" };
  if (served !== row.templateSha256) return { view: "text", reason: "template_changed" };
  if (!live || live.sha256 !== row.templateSha256) return { view: "text", reason: "no_access" };
  const tool = live.connector.tools.find((t) => t.name === row.tool);
  if (!tool || tool.status !== "pinned") return { view: "text", reason: "template_changed" };
  if (!appVisible(tool)) return { view: "text", reason: "not_app_visible" };
  return { view: "app" };
}

/** The thread's claimed results as the viewer sees them; the caller checked the thread is theirs to read. */
export async function appResultViews(
  db: KobeDb,
  tx: KobeTx,
  ids: { readonly teamId: string; readonly userId: string; readonly threadId: string },
): Promise<{ results: AppResultView[]; truncated: boolean }> {
  const rows = await tx
    .select({
      id: threadAppResults.id,
      runId: threadAppResults.runId,
      toolCallId: threadAppResults.toolCallId,
      entryId: threadAppResults.entryId,
      connectorId: threadAppResults.connectorId,
      tool: threadAppResults.tool,
      templateUri: threadAppResults.templateUri,
      templateSha256: threadAppResults.templateSha256,
      appId: threadAppResults.appId,
      storage: threadAppResults.storage,
      createdAt: threadAppResults.createdAt,
      promptEntryId: threadAppResults.promptEntryId,
      queuedAt: threadAppResults.queuedAt,
      userEntryId: runs.userEntryId,
    })
    .from(threadAppResults)
    .leftJoin(
      runs,
      and(eq(runs.teamId, threadAppResults.teamId), eq(runs.id, threadAppResults.runId)),
    )
    .where(
      and(
        eq(threadAppResults.teamId, ids.teamId),
        eq(threadAppResults.threadId, ids.threadId),
        or(isNotNull(threadAppResults.toolCallId), isNotNull(threadAppResults.entryId)),
      ),
    )
    .orderBy(desc(threadAppResults.createdAt))
    .limit(MAX_APP_RESULTS + 1);
  const truncated = rows.length > MAX_APP_RESULTS;
  const kept = rows.slice(0, MAX_APP_RESULTS).reverse();
  if (kept.length === 0) return { results: [], truncated };

  const apps = new Map(
    (await memberApps(db, ids.teamId, ids.userId)).map((a) => [a.appId, a] as const),
  );
  const connectorIds = [...new Set(kept.map((r) => r.connectorId))];
  const names = new Map(
    (
      await db
        .select({ id: connectors.id, name: connectors.name })
        .from(connectors)
        .where(inArray(connectors.id, connectorIds))
    ).map((c) => [c.id, c.name] as const),
  );
  const served = new Map<string, string | undefined>();
  for (const r of kept) {
    const key = `${r.connectorId} ${r.templateUri}`;
    if (!served.has(key)) {
      served.set(key, await servedTemplateHash(db, r.connectorId, r.templateUri));
    }
  }
  const results = kept.map((r): AppResultView => {
    const live = apps.get(r.appId);
    const decided = decide(r, live, served.get(`${r.connectorId} ${r.templateUri}`));
    return {
      result_ref: r.id,
      run_id: r.runId,
      user_entry_id: r.promptEntryId ?? r.userEntryId ?? null,
      tool_call_id: r.toolCallId,
      entry_id: r.entryId,
      connector_id: r.connectorId,
      connector_name: names.get(r.connectorId) ?? "a connector",
      tool: r.tool,
      app_id: r.appId,
      template_sha256: r.templateSha256,
      queued: r.queuedAt !== null,
      ...(decided.view === "app"
        ? {
            view: "app" as const,
            app: {
              title: live?.title ?? r.tool,
            },
          }
        : { view: "text" as const, reason: decided.reason }),
    };
  });
  return { results, truncated };
}

const readBlob = createReadLimiter({ max: 4, queueMax: 16, waitMs: 5_000 });
const BLOB_READ_MS = 15_000;
const MAX_RESULT_BLOB_BYTES = 4 * 1024 * 1024 + 1024;
/** Result reads one member may have in flight on this pod (review LOW-5). */
const READS_PER_USER = 2;
const readsInFlight = new Map<string, number>();

export type StoredResult =
  | {
      readonly ok: true;
      readonly input: Record<string, unknown> | null;
      readonly result: Record<string, unknown>;
    }
  | { readonly ok: false; readonly code: "not_found" | "text_only" | "busy" | "unavailable" };

/**
 * One stored result, only when the viewer may open it as an app now: that row alone is decided
 * (review LOW-5), with the call's stored input (LOW-2).
 */
export async function readAppResult(
  db: KobeDb,
  tx: KobeTx,
  blobs: BlobStore | undefined,
  ids: { readonly teamId: string; readonly userId: string; readonly threadId: string },
  ref: string,
  signal?: AbortSignal,
): Promise<StoredResult> {
  const [row] = await tx
    .select({
      id: threadAppResults.id,
      runId: threadAppResults.runId,
      toolCallId: threadAppResults.toolCallId,
      entryId: threadAppResults.entryId,
      connectorId: threadAppResults.connectorId,
      tool: threadAppResults.tool,
      templateUri: threadAppResults.templateUri,
      templateSha256: threadAppResults.templateSha256,
      appId: threadAppResults.appId,
      storage: threadAppResults.storage,
      input: threadAppResults.input,
      result: threadAppResults.result,
      blobRef: threadAppResults.blobRef,
    })
    .from(threadAppResults)
    .where(
      and(
        eq(threadAppResults.teamId, ids.teamId),
        eq(threadAppResults.threadId, ids.threadId),
        eq(threadAppResults.id, ref),
        or(isNotNull(threadAppResults.toolCallId), isNotNull(threadAppResults.entryId)),
      ),
    );
  if (!row) return { ok: false, code: "not_found" };
  const live = (await memberApps(db, ids.teamId, ids.userId)).find((a) => a.appId === row.appId);
  const served = await servedTemplateHash(db, row.connectorId, row.templateUri);
  if (decide(row, live, served).view !== "app") return { ok: false, code: "text_only" };
  const input = row.input ?? null;
  if (row.result) return { ok: true, input, result: row.result };
  if (!row.blobRef) return { ok: false, code: "text_only" };
  const inFlight = readsInFlight.get(ids.userId) ?? 0;
  if (inFlight >= READS_PER_USER) return { ok: false, code: "busy" };
  readsInFlight.set(ids.userId, inFlight + 1);
  const key = row.blobRef;
  try {
    const read = await readBlob(() => {
      const bound = AbortSignal.timeout(BLOB_READ_MS);
      return readOffloadedJson(
        blobs,
        { teamId: ids.teamId, threadId: ids.threadId, reader: "app result" },
        key,
        MAX_RESULT_BLOB_BYTES,
        signal ? AbortSignal.any([signal, bound]) : bound,
      );
    }, signal);
    if (!read.ok) return { ok: false, code: "busy" };
    if (!read.value.ok) return { ok: false, code: "unavailable" };
    const body = read.value.body;
    if (typeof body !== "object" || body === null || Array.isArray(body)) {
      return { ok: false, code: "unavailable" };
    }
    return { ok: true, input, result: body as Record<string, unknown> };
  } finally {
    const left = (readsInFlight.get(ids.userId) ?? 1) - 1;
    if (left <= 0) readsInFlight.delete(ids.userId);
    else readsInFlight.set(ids.userId, left);
  }
}
