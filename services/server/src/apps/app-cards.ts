import { connectorsOffIn } from "../connectors/thread-connectors.js";
import { randomUUID } from "node:crypto";
import {
  APP_CARD_CUSTOM_TYPE,
  APP_CARDS_PER_RUN_MAX,
  appCardContent,
  appCardEntryId,
  appCardEntrySchema,
  isAppCardEntryId,
  type AppCardDetails,
  type AppCardEntry,
} from "@kobe/protocol";
import {
  SYSTEM_ACTOR,
  parseToolsSnapshot,
  sql,
  threadAppResults,
  threadEntries,
  withTeam,
  type KobeTx,
} from "@kobe/db";
import { recordAudit } from "../audit/record.js";
import { usableSiteKeyIds } from "../connectors/site-key.js";
import type { RateLimiter } from "../sandbox/rate-limit.js";
import { loadUserGrantFacts } from "../runs/run-mcp.js";
import { piBranchPoint } from "../runs/run-prompt.js";
import { abortPending } from "../runs/store.js";
import { fallbackTitle } from "../threads/title.js";
import { appTitle } from "./app-title.js";
import { createThread } from "../threads/repository.js";
import { callApp, type AppCallDeps, type BrowserPrincipal } from "./call.js";
import { memberApp, type MemberApp } from "./catalog.js";
import { exposedToApps } from "./decide.js";
import { persistAppResult, type AppResultStoreDeps } from "./results-store.js";

/**
 * Rail launches (KOBE-440, spec MA11): the member clicks an app in the Workspace Rail and Kobe
 * calls its opening tool through the MA-4 path (`callApp`: MA8, read-only, policy at
 * `app_bridge`, audited `mcp.app_call`, the member's own credential), stores the full result
 * (MA10, keyed by the card's entry id) and appends an **app card** entry. No run, no
 * `run_events`, no model call, no spend, and nothing is sent to the sandbox: the next run's
 * `run.start` carries the cards Pi does not have yet (`appCardChain`).
 *
 * During an active run the launch waits (D17): the row keeps the card's text with `queued_at`
 * set, and the run's end inserts it (`insertQueuedAppCardsInTx`, from `promoteInTx` under the
 * thread lock) before the next queued message starts, after re-checking the member's access.
 * The opening tool is called at the click, so a waiting card can be expanded.
 *
 * **No app card may leave a thread unable to run** (coordinator rule, review MEDIUM-1/2, LOW-1):
 * - its content always fits its entry (`appCardContent` caps after escaping; the entry is
 *   validated before it is written);
 * - its parent is always an entry Pi has or will be given: never an unsent prompt (`ku-`,
 *   skipped with `piBranchPoint`), and only another card when that chain is complete;
 * - at most {@link APP_CARDS_PER_RUN_MAX} cards follow each other, so one `run.start` carries the
 *   whole chain.
 */
export interface AppCardDeps {
  readonly call: AppCallDeps;
  readonly store: AppResultStoreDeps;
  /** Launches per member (review LOW-3): a launch writes, so a tighter bucket than app calls. */
  readonly launches: RateLimiter;
  /** Stop's grace (re-review LOW-R2): a launch while Pi still aborts a stopped run waits. */
  readonly abortHoldMs?: () => number;
}

/** A burst of 5 launches, then one every 2 s, per member and server pod. */
export const APP_LAUNCH_RATE = { capacity: 5, refillPerSecond: 0.5 } as const;

/** Waiting cards one thread may hold. */
export const MAX_QUEUED_APP_CARDS = 5;

/** A waiting card older than this is dropped at insertion (review LOW-2). */
export const QUEUED_APP_CARD_MAX_AGE_MS = 10 * 60 * 1000;

type Status = 403 | 404 | 409 | 422 | 429 | 502 | 503;

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
      readonly status: Status;
      readonly code: string;
      readonly message: string;
    };

const refusal = (status: Status, code: string, message: string): LaunchOutcome => ({
  ok: false,
  status,
  code,
  message,
});
const THREAD_NOT_FOUND = refusal(404, "thread_not_found", "No thread with that id.");
const NOT_AVAILABLE = refusal(404, "app_not_available", "This app is not available to you.");
/** KOBE-451 review LOW-5: the owner turned the app's connector off for this conversation. */
const CONNECTOR_OFF = refusal(
  409,
  "connector_off",
  "This app's connector is off in this conversation. Turn it on from the + menu first.",
);
const TOO_MANY_QUEUED = refusal(
  429,
  "too_many_queued",
  "Several apps already wait for this run. Wait for it to end.",
);
const TOO_MANY_CARDS = refusal(
  409,
  "too_many_cards",
  `This conversation has ${APP_CARDS_PER_RUN_MAX} apps in a row. Send a message before you open more.`,
);
const OPEN_FAILED = refusal(
  502,
  "app_open_failed",
  "The app could not be opened: its tool returned an error.",
);
const RATE_LIMITED = refusal(429, "rate_limited", "You are opening apps too fast. Wait a moment.");
const INVALID_CARD = refusal(422, "app_card_invalid", "This app's result cannot be shown here.");

class CardRefused extends Error {
  constructor(readonly outcome: LaunchOutcome) {
    super("app card refused");
  }
}

interface CardThread {
  readonly id: string;
  readonly ownerUserId: string;
  readonly leafEntryId: string | null;
}

/** The thread, locked, when the member may add a card: theirs, live, not a test or eval thread. */
async function lockWritable(
  tx: KobeTx,
  teamId: string,
  threadId: string,
  userId: string,
): Promise<CardThread | undefined> {
  const res = await tx.execute<{
    id: string;
    owner_user_id: string;
    leaf_entry_id: string | null;
    deleted_at: unknown;
    is_test: boolean;
    skill_test: boolean;
    skill_eval: boolean;
  }>(sql`
    SELECT id, owner_user_id, leaf_entry_id, deleted_at, is_test, skill_test, skill_eval
      FROM threads WHERE team_id = ${teamId} AND id = ${threadId} FOR NO KEY UPDATE`);
  const t = res.rows[0];
  if (!t || t.owner_user_id !== userId || t.deleted_at !== null) return undefined;
  if (t.is_test || t.skill_test || t.skill_eval) return undefined;
  return { id: t.id, ownerUserId: t.owner_user_id, leafEntryId: t.leaf_entry_id };
}

async function hasActiveRun(tx: KobeTx, teamId: string, threadId: string): Promise<boolean> {
  const res = await tx.execute(sql`
    SELECT 1 FROM runs WHERE team_id = ${teamId} AND thread_id = ${threadId}
       AND status IN ('running', 'waiting_approval') LIMIT 1`);
  return (res.rowCount ?? res.rows.length) > 0;
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

/** Where a new card goes: below the leaf, past any unsent prompt Pi never had (MEDIUM-2). */
async function cardParent(tx: KobeTx, teamId: string, thread: CardThread): Promise<string | null> {
  return piBranchPoint(tx, teamId, thread.id, thread.leafEntryId);
}

/** How many cards follow each other ending at `entryId` (at most one more than the cap). */
async function cardsInARow(
  tx: KobeTx,
  teamId: string,
  threadId: string,
  entryId: string | null,
): Promise<number> {
  return (await appCardChain(tx, teamId, threadId, entryId, APP_CARDS_PER_RUN_MAX + 1)).length;
}

/**
 * Appends a card below the thread's leaf (the caller holds the thread lock) and moves the leaf.
 * Refuses (throws {@link CardRefused}) a card that could stop the thread's next run.
 */
export async function insertAppCardInTx(
  tx: KobeTx,
  teamId: string,
  thread: CardThread,
  card: { readonly entryId: string; readonly content: string; readonly details: AppCardDetails },
): Promise<CardThread> {
  const parentId = await cardParent(tx, teamId, thread);
  if ((await cardsInARow(tx, teamId, thread.id, parentId)) >= APP_CARDS_PER_RUN_MAX) {
    throw new CardRefused(TOO_MANY_CARDS);
  }
  const parsed = appCardEntrySchema.safeParse({
    type: "custom_message",
    id: card.entryId,
    parentId,
    timestamp: new Date().toISOString(),
    customType: APP_CARD_CUSTOM_TYPE,
    content: card.content,
    display: true,
    details: card.details,
  } satisfies AppCardEntry);
  if (!parsed.success) throw new CardRefused(INVALID_CARD);
  await tx.insert(threadEntries).values({
    teamId,
    threadId: thread.id,
    entryId: card.entryId,
    parentId,
    type: "custom_message",
    payload: parsed.data as unknown as Record<string, unknown>,
  });
  await tx.execute(sql`
    UPDATE threads SET leaf_entry_id = ${card.entryId}, last_activity_at = now()
     WHERE team_id = ${teamId} AND id = ${thread.id}`);
  return { ...thread, leafEntryId: card.entryId };
}

/**
 * Launches `appId` into `threadId` (or a new thread, titled after the app, with the team's
 * default agent). Fails closed: nothing is stored, inserted or created unless the call succeeded
 * and the card can go in.
 */
export async function launchAppCard(
  deps: AppCardDeps,
  p: BrowserPrincipal,
  threadId: string | null,
  appId: string,
): Promise<LaunchOutcome> {
  if (deps.launches.take(p.userId) !== 0) return RATE_LIMITED;
  const db = deps.call.db;
  const app = await memberApp(db, p.teamId, p.userId, appId);
  if (!app) return NOT_AVAILABLE;
  if (threadId !== null) {
    const pre = await withTeam(db, p.teamId, async (tx) => {
      const thread = await lockWritable(tx, p.teamId, threadId, p.userId);
      if (!thread) return THREAD_NOT_FOUND;
      if ((await connectorsOffIn(tx, p.teamId, threadId)).has(app.connector.id)) {
        return CONNECTOR_OFF;
      }
      if ((await queuedCount(tx, p.teamId, threadId)) >= MAX_QUEUED_APP_CARDS) {
        return TOO_MANY_QUEUED;
      }
      const row = await cardsInARow(tx, p.teamId, threadId, await cardParent(tx, p.teamId, thread));
      return row >= APP_CARDS_PER_RUN_MAX ? TOO_MANY_CARDS : undefined;
    });
    if (pre) return pre;
  }
  const called = await callApp(deps.call, p, appId, { tool: app.tool.name, arguments: {} });
  if (!called.ok) return called;
  if (called.result["isError"] === true) return OPEN_FAILED;
  return storeCard(deps.store, p, threadId, app, called.result, deps.abortHoldMs?.() ?? 0);
}

/** The app's title as a thread title: the title rules' unsafe characters removed (LOW-5). */
export function titleOf(app: Pick<MemberApp, "tool" | "title">): string {
  return fallbackTitle(app.title) ?? appTitle(app.tool, undefined);
}

async function storeCard(
  store: AppResultStoreDeps,
  p: BrowserPrincipal,
  existing: string | null,
  app: MemberApp,
  result: Record<string, unknown>,
  abortHoldMs: number,
): Promise<LaunchOutcome> {
  const id = randomUUID();
  // A new thread is created in the same transaction as its card (review LOW-4): a refusal or a
  // failure leaves no empty thread behind.
  const threadId = existing ?? randomUUID();
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
  try {
    return await persistAppResult<LaunchOutcome>(
      store,
      place,
      result,
      async (tx, storage, kept, bytes) => {
        if (existing === null) {
          await createThread(tx, {
            id: threadId,
            teamId: p.teamId,
            ownerUserId: p.userId,
            projectId: null,
            agent: null,
            title: titleOf(app),
          });
        }
        let thread = await lockWritable(tx, p.teamId, threadId, p.userId);
        if (!thread) return { stored: false, value: THREAD_NOT_FOUND };
        // A run is active, or Pi still aborts a stopped one (LOW-R2): the card waits for the run's
        // end or the hold's (the sweep then inserts it).
        const queued =
          (await hasActiveRun(tx, p.teamId, threadId)) ||
          (abortHoldMs > 0 && (await abortPending(tx, p.teamId, threadId, abortHoldMs)));
        if (queued && (await queuedCount(tx, p.teamId, threadId)) >= MAX_QUEUED_APP_CARDS) {
          return { stored: false, value: TOO_MANY_QUEUED };
        }
        // Cards still waiting with no run left to end go in first, in launch order (LOW-2).
        if (!queued) thread = await insertQueuedAppCardsInTx(tx, p.teamId, thread);
        if (queued && !appCardEntrySchema.shape.content.safeParse(content).success) {
          return { stored: false, value: INVALID_CARD };
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
          value: { ok: true, threadId, resultRef: id, ...(queued ? {} : { entryId }), queued },
        };
      },
    );
  } catch (err) {
    if (err instanceof CardRefused) return err.outcome;
    throw err;
  }
}

type QueuedRow = {
  readonly id: string;
  readonly entry_id: string;
  readonly card_text: string;
  readonly connector_id: string;
  readonly app_id: string;
  readonly tool: string;
  readonly template_uri: string;
  readonly template_sha256: string;
  readonly opened_by: string | null;
  readonly blob_ref: string | null;
  readonly waited_ms: number;
};

/** Why a waiting card is not inserted (audited `mcp.app_card_dropped`). */
export type DropReason = "no_access" | "expired" | "too_many_cards" | "invalid";

/**
 * Review LOW-2: the member still has the app at insertion (plain SQL in the thread's
 * transaction): the connector is active and enabled for the team, the template is the same
 * pinned and approved one, and the member can still call it (`none`, a site key bound to its URL,
 * or their own grant of its kind).
 */
async function stillLaunchable(tx: KobeTx, teamId: string, row: QueuedRow): Promise<boolean> {
  if (row.opened_by === null) return false;
  const res = await tx.execute<{
    auth_kind: string;
    credential_source: string;
    tools_snapshot: unknown;
    exposure: string | null;
    enabled_tools: string[] | null;
    template: boolean;
  }>(sql`
    SELECT c.auth_kind, c.credential_source, c.tools_snapshot, tc.exposure, tc.enabled_tools,
           EXISTS (SELECT 1 FROM connector_ui_resources u
                    WHERE u.connector_id = c.id AND u.uri = ${row.template_uri}
                      AND u.status = 'pinned' AND u.approved AND u.sha256 = ${row.template_sha256})
             AS template
      FROM connectors c
      LEFT JOIN team_connectors tc ON tc.team_id = ${teamId} AND tc.connector_id = c.id
     WHERE c.id = ${row.connector_id} AND c.status = 'active' AND c.deleted_at IS NULL`);
  const c = res.rows[0];
  if (!c || c.exposure === null || !c.template) return false;
  // The opening tool (re-review LOW-R1): still pinned, not drifted, naming the template, and in the
  // team's exposure (MA8).
  const tool = parseToolsSnapshot(c.tools_snapshot).find((t) => t.name === row.tool);
  if (!tool || tool.status !== "pinned" || tool.ui?.resource_uri !== row.template_uri) return false;
  const exposure = {
    exposure: c.exposure as Parameters<typeof exposedToApps>[0]["exposure"],
    enabledTools: c.enabled_tools ?? [],
  };
  if (!exposedToApps(exposure, tool)) return false;
  if (c.auth_kind === "none") return true;
  if (c.credential_source === "site") {
    return (await usableSiteKeyIds(tx, [row.connector_id])).has(row.connector_id);
  }
  const grants = await loadUserGrantFacts(tx, teamId, row.opened_by);
  return grants.some((g) => g.connectorId === row.connector_id && g.kind === c.auth_kind);
}

async function dropQueued(
  tx: KobeTx,
  teamId: string,
  thread: CardThread,
  row: QueuedRow,
  reason: DropReason,
): Promise<void> {
  await tx.execute(sql`
    DELETE FROM thread_app_results WHERE team_id = ${teamId} AND id = ${row.id}`);
  if (row.blob_ref !== null) {
    await tx.execute(sql`
      INSERT INTO retention_blob_deletions (team_id, key, thread_id, owner_user_id, enqueued_at)
      VALUES (${teamId}, ${row.blob_ref}, ${thread.id}, ${thread.ownerUserId}, now())
      ON CONFLICT (team_id, key) DO NOTHING`);
  }
  await recordAudit(tx, {
    action: "mcp.app_card_dropped",
    teamId,
    actor: SYSTEM_ACTOR,
    target: {
      connectorId: row.connector_id,
      userId: row.opened_by ?? thread.ownerUserId,
      threadId: thread.id,
      tool: /^[A-Za-z0-9_.-]{1,128}$/.test(row.tool) ? row.tool : "invalid",
      reason,
    },
  });
}

/**
 * The run ended (or none is active): inserts the thread's waiting cards in launch order, each at
 * the leaf, re-checking each one (LOW-2). A card the member can no longer open, one that waited
 * more than 10 minutes, or one that would make the cards in a row too many is dropped instead
 * (audited; the chat says so). Called under the thread lock.
 */
export async function insertQueuedAppCardsInTx<T extends CardThread>(
  tx: KobeTx,
  teamId: string,
  thread: T,
): Promise<T> {
  const res = await tx.execute<QueuedRow>(sql`
    SELECT id, entry_id, card_text, connector_id, app_id, tool, template_uri, template_sha256,
           opened_by, blob_ref,
           (extract(epoch FROM now() - queued_at) * 1000)::float8 AS waited_ms
      FROM thread_app_results
     WHERE team_id = ${teamId} AND thread_id = ${thread.id} AND queued_at IS NOT NULL
     ORDER BY queued_at, id`);
  let at: T = thread;
  for (const row of res.rows) {
    const reason: DropReason | undefined =
      Number(row.waited_ms) > QUEUED_APP_CARD_MAX_AGE_MS
        ? "expired"
        : !(await stillLaunchable(tx, teamId, row))
          ? "no_access"
          : undefined;
    if (reason !== undefined) {
      await dropQueued(tx, teamId, at, row, reason);
      continue;
    }
    try {
      // A savepoint: a refused card is dropped, never the transaction that ends a run.
      at = await tx.transaction(async (sp) => {
        const next = await insertAppCardInTx(sp, teamId, at, {
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
        await sp.execute(sql`
          UPDATE thread_app_results SET queued_at = NULL, card_text = NULL
           WHERE team_id = ${teamId} AND id = ${row.id}`);
        return { ...at, leafEntryId: next.leafEntryId };
      });
    } catch (err) {
      if (!(err instanceof CardRefused)) throw err;
      await dropQueued(
        tx,
        teamId,
        at,
        row,
        err.outcome.ok || err.outcome.code !== "too_many_cards" ? "invalid" : "too_many_cards",
      );
    }
  }
  return at;
}

/**
 * The app cards a run starting at `parentEntryId` brings Pi up to date with: the unbroken chain of
 * card entries ending there, oldest first (the agent skips any it already has). Empty when the
 * branch point is not a card. Launches keep every chain within the cap, so this is the whole one.
 */
export async function appCardChain(
  tx: KobeTx,
  teamId: string,
  threadId: string,
  parentEntryId: string | null,
  max: number = APP_CARDS_PER_RUN_MAX,
): Promise<AppCardEntry[]> {
  const chain: AppCardEntry[] = [];
  let at = parentEntryId;
  while (at !== null && isAppCardEntryId(at) && chain.length < max) {
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
    const thread = await lockWritable(tx, p.teamId, threadId, p.userId);
    if (!thread) return false;
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
