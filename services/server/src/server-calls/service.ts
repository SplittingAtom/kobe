import { sql, withTeam, type KobeDb } from "@kobe/db";
import { serverCallPurposeSchema, type ServerCallPurpose } from "@kobe/protocol";
import type { Logger } from "pino";
import type { BackgroundTasks } from "../background.js";
import { appendRunEvents } from "../event-stream/append.js";
import type { ServerCallClient } from "../models/gateway-client.js";
import type { RunAgentResolver } from "../runs/seams.js";
import { loadTitleSource, normaliseTitle, saveGeneratedTitle } from "../threads/title.js";
import { runEpilogue } from "./epilogue.js";

/**
 * The server's post-run model calls (KOBE-234 contract; KOBE-219 titles). The run-end
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

export function createServerCalls(options: ServerCallsOptions): ServerCalls {
  const { db, client, agents, background } = options;

  const run = async (teamId: string, runId: string, threadId: string): Promise<void> => {
    const announced = await announcedEpilogue(db, teamId, runId);
    if (!announced.includes("title")) return;
    const log = options.log.child({ run_id: runId });
    await runEpilogue({
      threadId,
      title: async (signal) => {
        const source = await withTeam(db, teamId, (tx) =>
          loadTitleSource(tx, agents, { teamId, runId, threadId }),
        );
        if (!source) return undefined;
        const reply = await client.complete({
          purpose: "title",
          teamId,
          userId: source.userId,
          threadId,
          runId,
          model: source.model,
          messages: source.messages,
          signal,
        });
        return normaliseTitle(reply);
      },
      saveTitle: (title) => saveGeneratedTitle(db, teamId, threadId, title),
      append: async (event) => {
        await appendRunEvents(db, teamId, runId, [event]);
      },
      log,
    });
  };

  return {
    purposes: ["title"],
    afterRunCompleted({ teamId, runId, threadId }) {
      background.run("server call epilogue failed", () => run(teamId, runId, threadId), {
        run_id: runId,
      });
    },
  };
}
