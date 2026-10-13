import { sql, type KobeTx } from "@kobe/db";
import { z } from "zod";
import { uuidSchema } from "../threads/schemas.js";
import { RunError } from "./errors.js";

/**
 * Reordering a thread's queued messages (CE10, KOBE-206): `POST /v1/threads/{id}/queue/order`.
 * The body names every queued run of the thread once, in the new order. Bounded by the queue cap
 * (`RunTuning.maxQueuedPerThread`, 25 by default), so the server never reads more ids than a
 * thread can hold.
 */
export const QUEUE_ORDER_MAX = 25;

export const queueOrderBodySchema = z.strictObject({
  run_ids: z
    .array(uuidSchema)
    .min(1)
    .max(QUEUE_ORDER_MAX)
    .refine((ids) => new Set(ids).size === ids.length, "run_ids must not repeat an id."),
});
export type QueueOrderBody = z.infer<typeof queueOrderBodySchema>;

interface QueuedRow {
  readonly id: string;
  readonly retry: boolean;
}

/**
 * Rewrites `queue_pos` of the thread's queued runs to follow `runIds`. The caller holds the thread
 * row lock (`lockOwnedThread`), the same lock that run start, submit and resume take, so no run
 * leaves or joins the queue meanwhile. `runIds` must be exactly the queued set, else
 * `queue_changed` (the client's view is stale: it reads the queue again).
 *
 * Retries keep running first (D14): the queue rank sorts retries ahead of fresh messages whatever
 * `queue_pos` says, so the positions are written retries first (each group in the order given)
 * and `queue_pos` agrees with the rank the client reads back.
 *
 * `runs_queue_pos_unique` (team, thread, queue_pos) among queued runs is checked per row, so the
 * rewrite runs in two steps: first above every current position (no clash with untouched rows),
 * then down to 1..n (every row already sits above n).
 */
export async function reorderQueuedRuns(
  tx: KobeTx,
  teamId: string,
  threadId: string,
  runIds: readonly string[],
): Promise<void> {
  const res = await tx.execute<{ id: string; retry: boolean; queue_pos: number }>(sql`
    SELECT id, retry_of_run_id IS NOT NULL AS retry, queue_pos FROM runs
     WHERE team_id = ${teamId} AND thread_id = ${threadId} AND status = 'queued'
     FOR UPDATE`);
  const queued: QueuedRow[] = res.rows.map((r) => ({ id: r.id, retry: r.retry }));
  const known = new Set(queued.map((r) => r.id));
  if (queued.length !== runIds.length || !runIds.every((id) => known.has(id))) {
    throw new RunError("queue_changed");
  }
  const retries = new Set(queued.filter((r) => r.retry).map((r) => r.id));
  const order = [
    ...runIds.filter((id) => retries.has(id)),
    ...runIds.filter((id) => !retries.has(id)),
  ];
  const top = res.rows.reduce((max, r) => Math.max(max, Number(r.queue_pos)), 0);
  await writePositions(tx, teamId, order, top);
  await writePositions(tx, teamId, order, 0);
}

/** `queue_pos` = base + 1, base + 2, … in `order` (at most the queue cap of rows). */
async function writePositions(
  tx: KobeTx,
  teamId: string,
  order: readonly string[],
  base: number,
): Promise<void> {
  for (const [i, id] of order.entries()) {
    await tx.execute(sql`
      UPDATE runs SET queue_pos = ${base + i + 1}
       WHERE team_id = ${teamId} AND id = ${id} AND status = 'queued'`);
  }
}
