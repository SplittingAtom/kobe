import { randomUUID } from "node:crypto";
import {
  APP_CARD_CUSTOM_TYPE,
  APP_CARDS_PER_RUN_MAX,
  appCardContent,
  appCardEntryId,
  isActiveRunStatus,
  isAppCardEntryId,
  type AppCardDetails,
  type AppCardEntry,
  type RunStatus,
} from "@kobe/protocol";
import { sql, threadAppResults, threadEntries, withTeam, type KobeTx } from "@kobe/db";
import { createThread } from "../threads/repository.js";
import { lockThreadRow, type ThreadRow } from "../runs/store.js";
import { callApp, takeRateToken, type AppCallDeps, type BrowserPrincipal } from "./call.js";
import { memberApp, type MemberApp } from "./catalog.js";
import { persistAppResult, type AppResultStoreDeps } from "./results-store.js";

/**
 * Rail launches (KOBE-440, spec MA11): the member clicks an app in the Workspace Rail and Kobe
 * calls its opening tool through the MA-4 path (`callApp`: rate limit, MA8, read-only, policy at
 * `app_bridge`, audited `mcp.app_call`, the member's own credential), stores the full result
 * (MA10, keyed by the card's entry id) and appends an **app card** entry at the thread's leaf.
 * No run, no `run_events`, no model call, no spend, and nothing is sent to the sandbox: the next
 * run's `run.start` carries the cards Pi does not have yet (`appCardChain`).
 *
 * During an active run the launch waits (D17): the row keeps the card's text with `queued_at`
 * set, and the run's end inserts it (`insertQueuedAppCardsInTx`, from `promoteInTx` under the
 * thread lock) before the next queued message starts. The opening tool is called at the click,
 * so a waiting card can be expanded; its data is from the click, not from the insertion.
 */
export interface AppCardDeps {
  readonly call: AppCallDeps;
  readonly store: AppResultStoreDeps;
}

/** Waiting cards one thread may hold. */
export const MAX_QUEUED_APP_CARDS = 5;

export type LaunchOutcome =
  | {
      readonly ok: true;
      readonly threadId: string;
      readonly resultRef: string;
      readonly entryId?: string;
      readonly queued: boolean;
    }
  | {
      readonly ok: false;
      readonly status: 403 | 404 | 409 | 422 | 429 | 502 | 503;
      readonly code: string;
      readonly message: string;
    };

const THREAD_NOT_FOUND: LaunchOutcome = {
  ok: false,
  status: 404,
  code: "thread_not_found",
  message: "No thread with that id.",
};
const NOT_AVAILABLE: LaunchOutcome = {
  ok: false,
  status: 404,
  code: "app_not_available",
  message: "This app is not available to you.",
};
const TOO_MANY: LaunchOutcome = {
  ok: false,
  status: 429,
  code: "too_many_queued",
  message: "Several apps already wait for this run. Wait for it to end.",
};
const OPEN_FAILED: LaunchOutcome = {
  ok: false,
  status: 502,
  code: "app_open_failed",
  message: "The app could not be opened: its tool returned an error.",
};

/** A thread the member may add a card to: theirs, not in Trash, not a skill eval's or a test's. */
function writable(thread: ThreadRow | undefined, userId: string): thread is ThreadRow {
  return (
    thread !== undefined &&
    thread.ownerUserId === userId &&
    thread.deletedAt === null &&
    thread.skillEval !== true &&
    thread.skillTest !== true
  );
}

async function hasActiveRun(tx: KobeTx, teamId: string, threadId: string): Promise<boolean> {
  const res = await tx.execute<{ status: RunStatus }>(sql`
    SELECT status FROM runs WHERE team_id = ${teamId} AND thread_id = ${threadId}
       AND status IN ('running', 'waiting_approval')`);
  return res.rows.some((r) => isActiveRunStatus(r.status));
}

async function queuedCount(tx: KobeTx, teamId: string, threadId: string): Promise<number> {
  const res = await tx.execute<{ n: number }>(sql`
    SELECT count(*)::int AS n FROM thread_app_results
     WHERE team_id = ${teamId} AND thread_id = ${threadId} AND queued_at IS NOT NULL`);
  return res.rows[0]?.n ?? 0;
}

/** The text blocks of an MCP result, joined; what the model reads of the card (T14). */
export function resultText(result: Record<string, unknown>): string {
  const content = Array.isArray(result["content"]) ? (result["content"] as unknown[]) : [];
  const texts = content.flatMap((block) => {
    const b = block as { type?: unknown; text?: unknown } | null;
    return b?.type === "text" && typeof b.text === "string" ? [b.text] : [];
  });
  return texts.length > 0 ? texts.join("\n") : "(The app's tool returned no text.)";
}

/** Appends a card at the thread's leaf (the caller holds the thread lock) and moves the leaf. */
export async function insertAppCardInTx(
  tx: KobeTx,
  teamId: string,
  thread: Pick<ThreadRow, "id" | "leafEntryId">,
  card: { readonly entryId: string; readonly content: string; readonly details: AppCardDetails },
): Promise<void> {
  const payload: AppCardEntry = {
    type: "custom_message",
    id: card.entryId,
    parentId: thread.leafEntryId,
    timestamp: new Date().toISOString(),
    customType: APP_CARD_CUSTOM_TYPE,
    content: card.content,
    display: true,
    details: card.details,
  };
  await tx.insert(threadEntries).values({
    teamId,
    threadId: thread.id,
    entryId: card.entryId,
    parentId: thread.leafEntryId,
    type: "custom_message",
    payload: payload as unknown as Record<string, unknown>,
  });
  await tx.execute(sql`
    UPDATE threads SET leaf_entry_id = ${card.entryId}, last_activity_at = now()
     WHERE team_id = ${teamId} AND id = ${thread.id}`);
}

/**
 * Launches `appId` into `threadId` (or a new thread, titled after the app, with the team's
 * default agent). Fails closed: nothing is stored or inserted unless the call succeeded.
 */
export async function launchAppCard(
  deps: AppCardDeps,
  p: BrowserPrincipal,
  threadId: string | null,
  appId: string,
): Promise<LaunchOutcome> {
  const db = deps.call.db;
  const app = await memberApp(db, p.teamId, p.userId, appId);
  if (!app) return NOT_AVAILABLE;
  if (threadId !== null) {
    const pre = await withTeam(db, p.teamId, async (tx) => {
      const thread = await lockThreadRow(tx, p.teamId, threadId);
      if (!writable(thread, p.userId)) return THREAD_NOT_FOUND;
      return (await queuedCount(tx, p.teamId, threadId)) >= MAX_QUEUED_APP_CARDS
        ? TOO_MANY
        : undefined;
    });
    if (pre) return pre;
  }
  const limited = await takeRateToken(deps.call, p, appId);
  if (limited && !limited.ok) return limited;
  const called = await callApp(deps.call, p, appId, { tool: app.tool.name, arguments: {} });
  if (!called.ok) return called;
  if (called.result["isError"] === true) return OPEN_FAILED;

  const target =
    threadId ??
    (
      await withTeam(db, p.teamId, (tx) =>
        createThread(tx, {
          teamId: p.teamId,
          ownerUserId: p.userId,
          projectId: null,
          agent: null,
          title: titleOf(app),
        }),
      )
    ).thread_id;
  return storeCard(deps.store, p, target, app, called.result);
}

function titleOf(app: MemberApp): string {
  return (app.tool.title ?? app.tool.annotations.title ?? app.tool.name).slice(0, 200);
}

async function storeCard(
  store: AppResultStoreDeps,
  p: BrowserPrincipal,
  threadId: string,
  app: MemberApp,
  result: Record<string, unknown>,
): Promise<LaunchOutcome> {
  const id = randomUUID();
  const entryId = appCardEntryId(id);
  const content = appCardContent({
    connectorName: app.connector.name,
    tool: app.tool.name,
    text: resultText(result),
  });
  const details: AppCardDetails = {
    connector_id: app.connector.id,
    app_id: app.appId,
    tool: app.tool.name,
    template_sha256: app.sha256,
    result_ref: id,
    opened_by: p.userId,
  };
  const place = { teamId: p.teamId, threadId, userId: p.userId, id };
  return persistAppResult<LaunchOutcome>(store, place, result, async (tx, storage, kept, bytes) => {
    const thread = await lockThreadRow(tx, p.teamId, threadId);
    if (!writable(thread, p.userId)) return { stored: false, value: THREAD_NOT_FOUND };
    const queued = await hasActiveRun(tx, p.teamId, threadId);
    if (queued && (await queuedCount(tx, p.teamId, threadId)) >= MAX_QUEUED_APP_CARDS) {
      return { stored: false, value: TOO_MANY };
    }
    await tx.insert(threadAppResults).values({
      teamId: p.teamId,
      id,
      threadId,
      entryId,
      connectorId: app.connector.id,
      tool: app.tool.name,
      templateUri: app.uri,
      templateSha256: app.sha256,
      appId: app.appId,
      input: {},
      storage,
      result: kept.result ?? null,
      blobRef: kept.blobRef ?? null,
      bytes,
      openedBy: p.userId,
      cardText: queued ? content : null,
      queuedAt: queued ? new Date() : null,
    });
    if (!queued) await insertAppCardInTx(tx, p.teamId, thread, { entryId, content, details });
    return {
      stored: true,
      value: {
        ok: true,
        threadId,
        resultRef: id,
        ...(queued ? {} : { entryId }),
        queued,
      },
    };
  });
}

/**
 * The run ended (or none is active): inserts the thread's waiting cards in launch order, each at
 * the leaf. Called by `promoteInTx` under the thread lock, before the next queued run starts.
 */
export async function insertQueuedAppCardsInTx(
  tx: KobeTx,
  teamId: string,
  thread: Pick<ThreadRow, "id" | "leafEntryId" | "ownerUserId">,
): Promise<Pick<ThreadRow, "id" | "leafEntryId" | "ownerUserId">> {
  const res = await tx.execute<{
    id: string;
    entry_id: string;
    card_text: string;
    connector_id: string;
    app_id: string;
    tool: string;
    template_sha256: string;
    opened_by: string | null;
  }>(sql`
    SELECT id, entry_id, card_text, connector_id, app_id, tool, template_sha256, opened_by
      FROM thread_app_results
     WHERE team_id = ${teamId} AND thread_id = ${thread.id} AND queued_at IS NOT NULL
     ORDER BY queued_at, id`);
  let at = thread;
  for (const row of res.rows) {
    await insertAppCardInTx(tx, teamId, at, {
      entryId: row.entry_id,
      content: row.card_text,
      details: {
        connector_id: row.connector_id,
        app_id: row.app_id,
        tool: row.tool,
        template_sha256: row.template_sha256,
        result_ref: row.id,
        opened_by: row.opened_by ?? thread.ownerUserId,
      },
    });
    await tx.execute(sql`
      UPDATE thread_app_results SET queued_at = NULL, card_text = NULL
       WHERE team_id = ${teamId} AND id = ${row.id}`);
    at = { ...at, leafEntryId: row.entry_id };
  }
  return at;
}

/**
 * The app cards a run starting at `parentEntryId` brings Pi up to date with: the unbroken chain of
 * card entries ending there, oldest first (the agent skips any it already has). Empty when the
 * branch point is not a card.
 */
export async function appCardChain(
  tx: KobeTx,
  teamId: string,
  threadId: string,
  parentEntryId: string | null,
): Promise<AppCardEntry[]> {
  const chain: AppCardEntry[] = [];
  let at = parentEntryId;
  while (at !== null && isAppCardEntryId(at) && chain.length < APP_CARDS_PER_RUN_MAX) {
    const res = await tx.execute<{ parent_id: string | null; payload: AppCardEntry }>(sql`
      SELECT parent_id, payload FROM thread_entries
       WHERE team_id = ${teamId} AND thread_id = ${threadId} AND entry_id = ${at}
         AND type = 'custom_message'`);
    const row = res.rows[0];
    if (!row) break;
    chain.push(row.payload);
    at = row.parent_id;
  }
  return chain.reverse();
}

/** Removes a waiting card (the member's chip ×): the row goes, and a blob is queued for deletion. */
export async function removeQueuedAppCard(
  deps: Pick<AppCardDeps, "call">,
  p: BrowserPrincipal,
  threadId: string,
  resultRef: string,
): Promise<boolean> {
  return withTeam(deps.call.db, p.teamId, async (tx) => {
    const thread = await lockThreadRow(tx, p.teamId, threadId);
    if (!writable(thread, p.userId)) return false;
    const res = await tx.execute<{ blob_ref: string | null }>(sql`
      DELETE FROM thread_app_results
       WHERE team_id = ${p.teamId} AND thread_id = ${threadId} AND id = ${resultRef}
         AND queued_at IS NOT NULL
      RETURNING blob_ref`);
    const removed = res.rows[0];
    if (!removed) return false;
    if (removed.blob_ref !== null) {
      await tx.execute(sql`
        INSERT INTO retention_blob_deletions (team_id, key, thread_id, owner_user_id, enqueued_at)
        VALUES (${p.teamId}, ${removed.blob_ref}, ${threadId}, ${p.userId}, now())
        ON CONFLICT (team_id, key) DO NOTHING`);
    }
    return true;
  });
}
