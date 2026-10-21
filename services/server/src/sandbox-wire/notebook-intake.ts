import { sql, type KobeDb } from "@kobe/db";
import {
  NOTEBOOK_EXEC_OUTPUT_MAX_BYTES,
  NOTEBOOK_EXEC_OUTPUTS_MAX,
  type NotebookOutputFrame,
} from "@kobe/protocol";
import type { Logger } from "pino";
import { MAX_APPEND_BATCH, appendRunEventsInTx, withAppendTx } from "../event-stream/append.js";
import type { NotebookExec } from "./delivery.js";

/**
 * A connection's intake of `notebook.output` frames (KOBE-464; docs/specs/notebooks.md NB9, NB14).
 * The connection has already matched the frame to a `notebook.execute` it delivered; here each
 * execution's outputs are taken in order (index 0, 1, ...), within the per-execution caps, and
 * appended as the run's `notebook.output` events, batched while an append is in flight. A frame out
 * of order or over a cap is dropped and counted, never stored. `drain` resolves once everything
 * accepted for that command is stored: the command's answer is recorded only after it, so the
 * requester reads back every output it will save.
 */
export interface NotebookIntakeDeps {
  readonly db: KobeDb;
  readonly teamId: string;
  readonly runMaxEvents: number;
  readonly log: Pick<Logger, "warn">;
  /** A frame was dropped (out of order, over a cap, the run full or ended). */
  readonly dropped: (reason: string) => void;
}

interface ExecState {
  readonly exec: NotebookExec;
  next: number;
  bytes: number;
  queue: { readonly type: "notebook.output"; readonly payload: unknown }[];
  flushing: Promise<void>;
}

export class NotebookIntake {
  readonly #deps: NotebookIntakeDeps;
  readonly #execs = new Map<string, ExecState>();

  constructor(deps: NotebookIntakeDeps) {
    this.#deps = deps;
  }

  accept(commandId: string, exec: NotebookExec, frame: NotebookOutputFrame, bytes: number): void {
    let state = this.#execs.get(commandId);
    if (state === undefined) {
      state = { exec, next: 0, bytes: 0, queue: [], flushing: Promise.resolve() };
      this.#execs.set(commandId, state);
    }
    if (frame.index !== state.next) {
      this.#deps.dropped("out_of_order");
      return;
    }
    if (
      state.next >= NOTEBOOK_EXEC_OUTPUTS_MAX ||
      state.bytes + bytes > NOTEBOOK_EXEC_OUTPUT_MAX_BYTES
    ) {
      this.#deps.dropped("over_cap");
      return;
    }
    state.next += 1;
    state.bytes += bytes;
    state.queue.push({
      type: "notebook.output",
      payload: { exec_id: exec.execId, index: frame.index, output: frame.output },
    });
    if (state.queue.length === 1) this.#flush(state);
  }

  /** Everything accepted for this command is stored (or given up); then it is forgotten. */
  async drain(commandId: string): Promise<void> {
    const state = this.#execs.get(commandId);
    if (state === undefined) return;
    while (state.queue.length > 0) {
      this.#flush(state);
      await state.flushing;
    }
    await state.flushing;
    this.#execs.delete(commandId);
  }

  #flush(state: ExecState): void {
    state.flushing = state.flushing.then(async () => {
      const batch = state.queue.splice(0, MAX_APPEND_BATCH);
      if (batch.length === 0) return;
      const { teamId, runMaxEvents } = this.#deps;
      try {
        await withAppendTx(this.#deps.db, teamId, async (tx) => {
          const run = await tx.execute<{ last_seq: number }>(sql`
            SELECT last_seq FROM runs WHERE team_id = ${teamId} AND id = ${state.exec.runId}`);
          const last = run.rows[0]?.last_seq ?? runMaxEvents;
          // Room for `notebook.finished` and the run's own end stays.
          if (last + batch.length + 4 > runMaxEvents) throw new Error("run_full");
          await appendRunEventsInTx(tx, teamId, state.exec.runId, batch);
        });
      } catch (err) {
        this.#deps.dropped("append_failed");
        this.#deps.log.warn(
          { run_id: state.exec.runId, err: (err as Error).message },
          "notebook outputs not stored",
        );
      }
      if (state.queue.length > 0) this.#flush(state);
    });
  }
}
