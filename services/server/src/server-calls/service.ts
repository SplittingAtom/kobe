import { sql, withTeam, type KobeDb } from "@kobe/db";
import { serverCallPurposeSchema, type ServerCallPurpose } from "@kobe/protocol";
import type { Logger } from "pino";
import type { BackgroundTasks } from "../background.js";
import { appendRunEvents } from "../event-stream/append.js";
import { ServerCallError, type ServerCallClient } from "../models/gateway-client.js";
import type { RunAgentResolver } from "../runs/seams.js";
import { loadFollowupsSource, parseFollowups } from "../threads/followups.js";
import { loadTitleSource } from "../threads/title-source.js";
import {
  lastTitleAttempt,
  normaliseTitle,
  saveFallbackTitle,
  saveGeneratedTitle,
} from "../threads/title.js";
import { runEpilogue } from "./epilogue.js";

/**
 * The server's post-run model calls (KOBE-234 contract; KOBE-219 titles, KOBE-222 follow-ups). The run-end
 * transaction announces them in `run.completed.epilogue` (only the purposes in {@link
 * ServerCalls.purposes}); after it commits, {@link ServerCalls.afterRunCompleted} reads what was
 * announced and runs the calls off the run's path. Nothing here can change the run: it has ended,
 * and every failure is logged with a code and writes nothing.
 */
export interface ServerCalls {
  /** What `run.completed` may announce on this server (empty: nothing is configured). */
  readonly purposes: readonly ServerCallPurpose[];
  /** After a completed run committed; never throws, never waits. */
  afterRunCompleted(run: {
    readonly teamId: string;
    readonly runId: string;
    readonly threadId: string;
  }): void;
}

export const NO_SERVER_CALLS: ServerCalls = {
  purposes: [],
  afterRunCompleted: () => undefined,
};

export interface ServerCallsOptions {
  readonly db: KobeDb;
  readonly client: ServerCallClient;
  readonly agents: RunAgentResolver;
  readonly background: BackgroundTasks;
  readonly log: Logger;
}

/** The epilogue the run's `run.completed` announced (one indexed read of the run's tail). */
async function announcedEpilogue(
  db: KobeDb,
  teamId: string,
  runId: string,
): Promise<readonly ServerCallPurpose[]> {
  const res = await withTeam(db, teamId, (tx) =>
    tx.execute<{ epilogue: unknown }>(sql`
      SELECT e.payload -> 'epilogue' AS epilogue
        FROM runs r
        JOIN run_events e ON e.team_id = r.team_id AND e.run_id = r.id AND e.seq > r.last_seq - 3
       WHERE r.team_id = ${teamId} AND r.id = ${runId} AND e.type = 'run.completed'
       ORDER BY e.seq DESC LIMIT 1`),
  );
  const raw = res.rows[0]?.epilogue;
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((p) => {
    const parsed = serverCallPurposeSchema.safeParse(p);
    return parsed.success ? [parsed.data] : [];
  });
}

type Ids = { readonly teamId: string; readonly runId: string; readonly threadId: string };

export function createServerCalls(options: ServerCallsOptions): ServerCalls {
  const { db, client, agents, background } = options;

  /** The title call: throws a {@link ServerCallError} whose code says why nothing came of it. */
  const titleCall = async (ids: Ids, signal: AbortSignal, seen: { code?: string }) => {
    const { teamId, runId, threadId } = ids;
    const loaded = await withTeam(db, teamId, (tx) => loadTitleSource(tx, agents, ids));
    if (!loaded.ok) {
      seen.code = loaded.reason;
      throw new ServerCallError(loaded.reason);
    }
    const { source } = loaded;
    const reply = await client
      .complete({
        purpose: "title",
        teamId,
        userId: source.userId,
        threadId,
        runId,
        model: source.model,
        reasoning: source.reasoning,
        messages: source.messages,
        signal,
      })
      .catch((err: unknown) => {
        if (err instanceof ServerCallError) seen.code = err.code;
        throw err;
      });
    const title = normaliseTitle(reply);
    if (title === undefined) {
      seen.code = "schema_reject";
      throw new ServerCallError("schema_reject", 200, { model: source.model });
    }
    return title;
  };

  /**
   * No title came of this run (review M3): when none ever will (no model, no lease) or this was
   * the last attempt, the first line of the first prompt becomes the title, under the same guard,
   * and the rail hears of it like of a generated one.
   */
  const fallBack = async (ids: Ids, code: string | undefined, log: Logger) => {
    if (code === "titled" || code === "no_message") return;
    const permanent = code === "no_model" || code === "no_lease";
    const last =
      permanent ||
      (await withTeam(db, ids.teamId, (tx) => lastTitleAttempt(tx, ids.teamId, ids.threadId)));
    if (!last) return;
    const title = await saveFallbackTitle(db, ids);
    if (title === undefined) return;
    log.info({ purpose: "title", code: code ?? "unknown" }, "fallback title saved");
    await appendRunEvents(db, ids.teamId, ids.runId, [
      { type: "thread.updated", payload: { thread_id: ids.threadId, title } },
    ]).catch(() => log.info({ purpose: "title" }, "fallback title saved; its event was not"));
  };

  /** The follow-up call (KOBE-222): up to three lines, or a {@link ServerCallError} saying why not. */
  const followupsCall = async (ids: Ids, signal: AbortSignal) => {
    const { teamId, runId, threadId } = ids;
    const loaded = await withTeam(db, teamId, (tx) => loadFollowupsSource(tx, agents, ids));
    if (!loaded.ok) throw new ServerCallError(loaded.reason);
    const { source } = loaded;
    const reply = await client.complete({
      purpose: "followups",
      teamId,
      userId: source.userId,
      threadId,
      runId,
      model: source.model,
      reasoning: source.reasoning,
      messages: source.messages,
      signal,
    });
    const suggestions = parseFollowups(reply);
    if (suggestions === undefined) {
      throw new ServerCallError("schema_reject", 200, { model: source.model });
    }
    return suggestions;
  };

  const run = async (ids: Ids): Promise<void> => {
    const { teamId, runId, threadId } = ids;
    const announced = await announcedEpilogue(db, teamId, runId);
    const wantsTitle = announced.includes("title");
    const wantsFollowups = announced.includes("followups");
    if (!wantsTitle && !wantsFollowups) return;
    const log = options.log.child({ run_id: runId });
    const seen: { code?: string } = {};
    // Both start together (runEpilogue), so the epilogue window covers the longer one.
    const result = await runEpilogue({
      threadId,
      ...(wantsTitle ? { title: (signal: AbortSignal) => titleCall(ids, signal, seen) } : {}),
      ...(wantsFollowups ? { followups: (signal: AbortSignal) => followupsCall(ids, signal) } : {}),
      saveTitle: (title) => saveGeneratedTitle(db, teamId, threadId, title),
      append: async (event) => {
        await appendRunEvents(db, teamId, runId, [event]);
      },
      log,
    });
    if (result.title === "failed" || result.title === "skipped") {
      await fallBack(ids, seen.code, log);
    }
  };

  return {
    purposes: ["title", "followups"],
    afterRunCompleted({ teamId, runId, threadId }) {
      background.run("server call epilogue failed", () => run({ teamId, runId, threadId }), {
        run_id: runId,
      });
    },
  };
}
