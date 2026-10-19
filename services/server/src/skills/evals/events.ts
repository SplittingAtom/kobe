import { withTeam, type KobeDb, type TeamRole } from "@kobe/db";
import {
  skillEvalCompletedPayloadSchema,
  skillEvalProgressPayloadSchema,
  type SkillEvalRunView,
} from "@kobe/protocol";
import pg from "pg";
import type { Logger } from "pino";
import { SKILL_EVAL_CHANNEL } from "./store.js";
import { doneExecutions, readEvalRun, type EvalViewer } from "./views.js";

// Skill eval progress (KOBE-325): Postgres is the record (`skill_eval_runs.progress_done`, the
// result rows); `NOTIFY kobe_skill_eval '<team>:<eval run>'` only says "look again". One LISTEN
// connection per process fans hints out to the open streams; each stream also re-reads on a timer
// (the safety net for a lost hint). Events carry ids, statuses and numbers only.

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export class SkillEvalHub {
  readonly #subs = new Map<string, Set<() => void>>();
  readonly #connectionString: string;
  readonly #log: Pick<Logger, "warn">;
  #client: pg.Client | undefined;
  #closed = false;

  constructor(connectionString: string, log: Pick<Logger, "warn">) {
    this.#connectionString = connectionString;
    this.#log = log;
  }

  start(): void {
    void this.#listen();
  }

  /** Calls `hint` for every notification about that eval run until the returned function runs. */
  subscribe(evalRunId: string, hint: () => void): () => void {
    let set = this.#subs.get(evalRunId);
    if (!set) this.#subs.set(evalRunId, (set = new Set()));
    set.add(hint);
    return () => {
      set.delete(hint);
      if (set.size === 0) this.#subs.delete(evalRunId);
    };
  }

  async close(): Promise<void> {
    this.#closed = true;
    await this.#client?.end().catch(() => undefined);
  }

  async #listen(): Promise<void> {
    if (this.#closed) return;
    const client = new pg.Client({
      connectionString: this.#connectionString,
      connectionTimeoutMillis: 10_000,
    });
    const retry = () => {
      if (this.#client !== client) return;
      this.#client = undefined;
      client.end().catch(() => undefined);
      if (!this.#closed) setTimeout(() => void this.#listen(), 2_000).unref();
    };
    client.on("error", retry);
    client.on("end", retry);
    client.on("notification", (n) => {
      if (n.channel !== SKILL_EVAL_CHANNEL) return;
      const id = n.payload?.split(":")[1];
      if (!id || !UUID.test(id)) return;
      for (const hint of this.#subs.get(id) ?? []) hint();
    });
    try {
      this.#client = client;
      await client.connect();
      await client.query(`LISTEN ${SKILL_EVAL_CHANNEL}`);
    } catch (err) {
      this.#log.warn({ err }, "skill eval events could not listen");
      retry();
    }
  }
}

const TERMINAL = new Set(["completed", "failed", "cancelled", "budget_stopped"]);

const frame = (type: string, id: string, data: unknown) =>
  `id: ${id}\nevent: ${type}\ndata: ${JSON.stringify(data)}\n\n`;

/** Open streams per viewer on this replica, and how long one stays open (review L5). */
export const SKILL_EVAL_STREAMS_PER_USER = 5;
export const SKILL_EVAL_STREAM_MAX_MS = 30 * 60_000;
const openStreams = new Map<string, number>();

export type StreamRefusal = "not_found" | "finished" | "too_many_streams";

/**
 * The SSE stream of one eval run: `skill.eval.progress` for each execution done (those done
 * before the stream opened first), then `skill.eval.completed` once the run ends, then the end
 * of the stream. Null when `who` may not read the eval.
 */
export async function skillEvalEventStream(
  deps: { readonly db: KobeDb; readonly hub: SkillEvalHub | undefined },
  who: EvalViewer,
  evalRunId: string,
  options: {
    readonly pollMs?: number;
    readonly keepaliveMs?: number;
    readonly maxMs?: number;
    /** A reconnect (`Last-Event-ID`): a finished eval answers no stream, so EventSource stops. */
    readonly reconnect?: boolean;
    /**
     * Re-checked every `revalidateMs` (as the thread stream does, re-review R2): the viewer's
     * session is live, the account active, and their current role in the team (null: none of
     * that any more, and the stream ends). The fresh role decides what they may still read.
     */
    readonly stillAllowed?: () => Promise<TeamRole | null>;
    readonly revalidateMs?: number;
  } = {},
): Promise<ReadableStream<Uint8Array> | StreamRefusal> {
  const first = await withTeam(deps.db, who.teamId, (tx) => readEvalRun(tx, who, evalRunId));
  if (!first) return "not_found";
  if (options.reconnect && TERMINAL.has(first.status)) return "finished";
  const open = openStreams.get(who.userId) ?? 0;
  if (open >= SKILL_EVAL_STREAMS_PER_USER) return "too_many_streams";
  openStreams.set(who.userId, open + 1);
  let counted = true;
  let viewer = who;
  let checkedAt = Date.now();
  const revalidateMs = options.revalidateMs ?? 30_000;
  const release = () => {
    if (!counted) return;
    counted = false;
    const n = (openStreams.get(who.userId) ?? 1) - 1;
    if (n <= 0) openStreams.delete(who.userId);
    else openStreams.set(who.userId, n);
  };
  const encoder = new TextEncoder();
  const sent = new Set<string>();
  let timer: NodeJS.Timeout | undefined;
  let keepalive: NodeJS.Timeout | undefined;
  let lifetime: NodeJS.Timeout | undefined;
  let unsubscribe: (() => void) | undefined;
  let reading = false;
  let again = false;
  let finished = false;
  const stop = () => {
    finished = true;
    if (timer) clearInterval(timer);
    if (keepalive) clearInterval(keepalive);
    if (lifetime) clearTimeout(lifetime);
    unsubscribe?.();
    release();
  };
  return new ReadableStream<Uint8Array>({
    start(controller) {
      const push = (text: string) => controller.enqueue(encoder.encode(text));
      const emit = async () => {
        if (options.stillAllowed && Date.now() - checkedAt >= revalidateMs) {
          const role = await options.stillAllowed();
          if (role === null) return true;
          viewer = { ...viewer, role };
          checkedAt = Date.now();
        }
        const read = await withTeam(deps.db, who.teamId, async (tx) => ({
          run: await readEvalRun(tx, viewer, evalRunId),
          done: await doneExecutions(tx, who.teamId, evalRunId),
        }));
        if (!read.run) return true;
        let done = 0;
        for (const d of read.done) {
          done += 1;
          const key = `${d.caseId}:${d.withSkill ? 1 : 0}`;
          if (sent.has(key)) continue;
          sent.add(key);
          push(
            frame(
              "skill.eval.progress",
              `p${done}`,
              skillEvalProgressPayloadSchema.parse({
                evalRunId,
                done,
                total: read.run.progress.total,
                caseId: d.caseId,
                withSkill: d.withSkill,
                status: d.status,
              }),
            ),
          );
        }
        if (!TERMINAL.has(read.run.status)) return false;
        push(frame("skill.eval.completed", "done", completedPayload(read.run)));
        return true;
      };
      const tick = () => {
        if (finished) return;
        if (reading) {
          again = true;
          return;
        }
        reading = true;
        emit()
          .then((end) => {
            if (end) {
              stop();
              controller.close();
            }
          })
          .catch(() => {
            stop();
            controller.close();
          })
          .finally(() => {
            reading = false;
            if (again && !finished) {
              again = false;
              tick();
            }
          });
      };
      unsubscribe = deps.hub?.subscribe(evalRunId, tick);
      timer = setInterval(tick, options.pollMs ?? 5_000);
      timer.unref();
      keepalive = setInterval(() => push(": keepalive\n\n"), options.keepaliveMs ?? 15_000);
      keepalive.unref();
      // A stream ends after a while; the client reconnects (and a finished eval answers 204).
      lifetime = setTimeout(() => {
        stop();
        controller.close();
      }, options.maxMs ?? SKILL_EVAL_STREAM_MAX_MS);
      lifetime.unref();
      push("retry: 3000\n\n");
      tick();
    },
    cancel() {
      stop();
    },
  });
}

function completedPayload(run: SkillEvalRunView) {
  const card = run.scorecard;
  return skillEvalCompletedPayloadSchema.parse({
    evalRunId: run.id,
    status: run.status,
    passRate: card?.passRate ?? null,
    baselinePassRate: card?.baselinePassRate ?? null,
    lift: card?.lift ?? null,
  });
}
