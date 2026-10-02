import { randomUUID } from "node:crypto";
import {
  serverToSandboxFrameSchema,
  type PiGetEntriesData,
  type ServerToSandboxFrame,
} from "@kobe/protocol";
import { sql, withTeam, type SandboxCommandKind } from "@kobe/db";
import { withAppendTx } from "../event-stream/append.js";
import type { Logger } from "pino";
import { completeCommand, markDelivered, pendingCommands, type CommandRow } from "./commands.js";
import type { WireContext } from "./context.js";
import {
  lastMirroredEntryId,
  mirrorEntriesInTx,
  parseGetEntries,
  restoreParts,
} from "./entries.js";
import { endRunInTx, loadRun } from "./run-state.js";
import { COMMAND_FAILURES, type CommandOutcome, type SandboxTarget } from "./types.js";

/** What delivery needs from its connection. */
export interface DeliveryHost {
  readonly id: string;
  readonly target: SandboxTarget;
  readonly sandboxId: string;
  readonly ready: boolean;
  readonly log: Logger;
  send(frame: ServerToSandboxFrame): boolean;
  hasLiveLease(runId: string): boolean;
  leaseRun(runId: string, threadId: string, cursor: number): void;
  leaseThread(threadId: string): void;
  endLease(runId: string): void;
}

export type IssuedCommand =
  | {
      readonly kind: "row";
      readonly rowId: string;
      readonly commandKind: SandboxCommandKind;
      readonly runId: string | null;
      readonly threadId: string;
      readonly requesterReplica: string;
    }
  | { readonly kind: "internal"; readonly resolve: (outcome: CommandOutcome) => void };

const INTERNAL_TIMEOUT_MS = 60_000;
const ANSWERED_MAX = 4_096;
const DRAIN_BATCH = 20;

const failure = (code: string, message: string): CommandOutcome => ({
  ok: false,
  error: { code, message },
});

/**
 * Server → sandbox commands on one connection: delivers the sandbox's pending command rows in order
 * (before a thread's first `run.start` on this connection it checks the Pi session against
 * Postgres and restores it if the volume was lost, KOBE-23), mints a fresh wire `command_id` per
 * delivery (ids are valid only on the connection that issued them), and records each
 * `command.result` for the requesting replica. Also runs the internal commands the wire itself
 * needs (`get_entries` for mirroring, `session.restore`).
 */
export class CommandDelivery {
  readonly #ctx: WireContext;
  readonly #host: DeliveryHost;
  readonly #issued = new Map<string, IssuedCommand>();
  readonly #answered = new Set<string>();
  readonly #synced = new Set<string>();
  #draining = false;
  #again = false;
  #closed = false;

  constructor(ctx: WireContext, host: DeliveryHost) {
    this.#ctx = ctx;
    this.#host = host;
  }

  /** Pending commands may exist: deliver them (coalesces concurrent pokes). */
  poke(): void {
    if (this.#closed || !this.#host.ready) return;
    if (this.#draining) {
      this.#again = true;
      return;
    }
    this.#draining = true;
    void this.#drain()
      .catch((err: unknown) => this.#host.log.warn({ err }, "command delivery failed"))
      .finally(() => {
        this.#draining = false;
        if (this.#again && !this.#closed) {
          this.#again = false;
          this.poke();
        }
      });
  }

  /** The issued command a `command.result` answers; "answered" for a duplicate result. */
  takeIssued(commandId: string): IssuedCommand | "answered" | undefined {
    const issued = this.#issued.get(commandId);
    if (issued === undefined) return this.#answered.has(commandId) ? "answered" : undefined;
    this.#issued.delete(commandId);
    this.#answered.add(commandId);
    if (this.#answered.size > ANSWERED_MAX) {
      const oldest = this.#answered.values().next().value;
      if (oldest !== undefined) this.#answered.delete(oldest);
    }
    return issued;
  }

  /** Records a command's outcome (and its effect on the run, for `run.start`). */
  settle(issued: IssuedCommand, outcome: CommandOutcome): void {
    if (issued.kind === "internal") {
      issued.resolve(outcome);
      return;
    }
    void this.#record(issued, outcome).catch((err: unknown) =>
      this.#host.log.error({ err, kind: issued.commandKind }, "could not record a command result"),
    );
  }

  forgetSession(threadId: string): void {
    this.#synced.delete(threadId);
  }

  close(): void {
    this.#closed = true;
    for (const [id, issued] of this.#issued) {
      if (issued.kind === "internal") {
        issued.resolve(failure(COMMAND_FAILURES.connectionLost, "the connection closed"));
      }
      this.#issued.delete(id);
    }
  }

  // ---------------------------------------------------------------- internal commands

  #internal(frame: ServerToSandboxFrame, timeoutMs = INTERNAL_TIMEOUT_MS): Promise<CommandOutcome> {
    if (this.#closed) return Promise.resolve(failure(COMMAND_FAILURES.connectionLost, "closed"));
    const commandId = "command_id" in frame ? frame.command_id : randomUUID();
    return new Promise<CommandOutcome>((resolve) => {
      const timer = setTimeout(() => {
        this.#issued.delete(commandId);
        resolve(failure(COMMAND_FAILURES.timeout, "the sandbox did not answer in time"));
      }, timeoutMs);
      timer.unref();
      this.#issued.set(commandId, {
        kind: "internal",
        resolve: (outcome) => {
          clearTimeout(timer);
          resolve(outcome);
        },
      });
      if (!this.#host.send(frame)) {
        this.#issued.delete(commandId);
        clearTimeout(timer);
        resolve(failure(COMMAND_FAILURES.connectionLost, "the connection closed"));
      }
    });
  }

  async #getEntries(threadId: string, since: string | undefined): Promise<CommandOutcome> {
    const id = randomUUID();
    this.#host.leaseThread(threadId);
    return this.#internal({
      v: 1,
      type: "pi.command",
      command_id: id,
      thread_id: threadId,
      command:
        since === undefined ? { id, type: "get_entries" } : { id, type: "get_entries", since },
    });
  }

  /** New entries of a thread since the last mirrored one; undefined when unavailable. */
  async fetchNewEntries(threadId: string): Promise<PiGetEntriesData | undefined> {
    const { teamId } = this.#host.target;
    const since = await withTeam(this.#ctx.db, teamId, (tx) =>
      lastMirroredEntryId(tx, teamId, threadId),
    );
    const outcome = await this.#getEntries(threadId, since);
    if (!outcome.ok) {
      this.#host.log.warn({ thread_id: threadId, code: outcome.error.code }, "entry sync failed");
      return undefined;
    }
    const data = parseGetEntries(outcome.data);
    if (!data) this.#host.log.warn({ thread_id: threadId }, "sandbox sent malformed entries");
    return data;
  }

  /**
   * Before a thread's first run on this connection: mirror what Pi has that Postgres doesn't, or —
   * when Pi no longer knows our last entry (volume lost, D13/D15) — rebuild Pi's session from
   * Postgres with `session.restore` (parts, each answered, the file renamed in on `final`).
   */
  async #ensureSession(threadId: string): Promise<CommandOutcome> {
    if (this.#synced.has(threadId)) return { ok: true };
    const { teamId } = this.#host.target;
    const db = this.#ctx.db;
    const since = await withTeam(db, teamId, (tx) => lastMirroredEntryId(tx, teamId, threadId));
    const outcome = await this.#getEntries(threadId, since);
    if (outcome.ok) {
      const data = parseGetEntries(outcome.data);
      if (data) {
        await withTeam(db, teamId, (tx) => mirrorEntriesInTx(tx, teamId, threadId, data));
      }
      this.#synced.add(threadId);
      return { ok: true };
    }
    if (outcome.error.code === "frame_too_large") {
      // Pi has more than one frame of new entries; they are mirrored as the run proceeds.
      this.#synced.add(threadId);
      return { ok: true };
    }
    if (since === undefined || outcome.error.code !== "pi_rejected") return outcome;
    this.#host.log.warn({ thread_id: threadId }, "Pi session lost; restoring from Postgres");
    const parts = await withTeam(db, teamId, (tx) => restoreParts(tx, teamId, threadId));
    for (const [part, entries] of parts.entries()) {
      const restored = await this.#internal({
        v: 1,
        type: "session.restore",
        command_id: randomUUID(),
        thread_id: threadId,
        part,
        final: part === parts.length - 1,
        entries,
      });
      if (!restored.ok) return restored;
    }
    this.#synced.add(threadId);
    return { ok: true };
  }

  // ---------------------------------------------------------------- command rows

  async #drain(): Promise<void> {
    for (;;) {
      if (this.#closed || !this.#host.ready) return;
      const { teamId } = this.#host.target;
      const rows = await withTeam(this.#ctx.db, teamId, (tx) =>
        pendingCommands(tx, this.#host.target, DRAIN_BATCH),
      );
      for (const row of rows) {
        if (this.#closed) return;
        await this.#deliver(row);
      }
      if (rows.length < DRAIN_BATCH) return;
    }
  }

  async #fail(row: CommandRow, outcome: CommandOutcome): Promise<void> {
    const { teamId } = this.#host.target;
    await withTeam(this.#ctx.db, teamId, (tx) =>
      completeCommand(tx, this.#ctx.bus, teamId, row.id, outcome),
    );
    if (row.requesterReplica === this.#ctx.replicaId) this.#ctx.localResult(row.id);
  }

  /** The wire frame for a stored command, with a fresh command id; undefined if invalid. */
  #frameFor(row: CommandRow, commandId: string): ServerToSandboxFrame | undefined {
    const base = { ...row.frame, v: 1, type: row.kind, command_id: commandId };
    const candidate =
      row.kind === "pi.command"
        ? { ...base, command: { ...(row.frame.command as object), id: commandId } }
        : base;
    const parsed = serverToSandboxFrameSchema.safeParse(candidate);
    if (!parsed.success) return undefined;
    // The stored frame must be about the row's thread and run (defence in depth).
    const f = parsed.data as { thread_id?: string; run_id?: string };
    if (f.thread_id !== row.threadId) return undefined;
    if (row.runId !== null && f.run_id !== row.runId) return undefined;
    return parsed.data;
  }

  async #deliver(row: CommandRow): Promise<void> {
    const ctx = this.#ctx;
    const { teamId, userId } = this.#host.target;
    const commandId = randomUUID();
    const frame = this.#frameFor(row, commandId);
    if (!frame) {
      await this.#fail(row, failure("invalid_command", "the stored command is not a valid frame"));
      return;
    }
    if (
      (row.kind === "run.steer" || row.kind === "run.stop") &&
      !this.#host.hasLiveLease(row.runId ?? "")
    ) {
      await this.#fail(row, failure("run_not_active", "the run is not active on this sandbox"));
      return;
    }
    if (row.kind === "run.start") {
      const session = await this.#ensureSession(row.threadId);
      if (!session.ok) {
        await this.#failRunStart(
          row,
          failure(COMMAND_FAILURES.sessionUnavailable, session.error.message),
        );
        return;
      }
    }
    const claimed = await withTeam(ctx.db, teamId, async (tx) => {
      if (row.kind === "run.start") {
        const run = await loadRun(tx, teamId, row.runId ?? "");
        if (
          !run ||
          run.ownerUserId !== userId ||
          run.threadId !== row.threadId ||
          (run.status !== "running" && run.status !== "waiting_approval")
        ) {
          return "run_not_active" as const;
        }
        const leased = await tx.execute(sql`
          INSERT INTO sandbox_run_leases (team_id, run_id, user_id, thread_id, sandbox_id)
          VALUES (${teamId}, ${row.runId}, ${userId}, ${row.threadId}, ${this.#host.sandboxId})
          ON CONFLICT (team_id, run_id) DO UPDATE
            SET sandbox_id = EXCLUDED.sandbox_id, leased_at = now()
            WHERE sandbox_run_leases.user_id = EXCLUDED.user_id
              AND sandbox_run_leases.thread_id = EXCLUDED.thread_id`);
        if (leased.rowCount !== 1) return "run_not_active" as const;
        if (!(await markDelivered(tx, teamId, row.id, this.#host.id))) return "gone" as const;
        return { cursor: run.sandboxSeq };
      }
      return (await markDelivered(tx, teamId, row.id, this.#host.id))
        ? { cursor: 0 }
        : ("gone" as const);
    });
    if (claimed === "gone") return; // expired or taken meanwhile
    if (claimed === "run_not_active") {
      await this.#fail(row, failure("run_not_active", "the run is not active"));
      return;
    }
    if (row.kind === "run.start" && row.runId !== null) {
      this.#host.leaseRun(row.runId, row.threadId, claimed.cursor);
    }
    this.#host.leaseThread(row.threadId);
    this.#issued.set(commandId, {
      kind: "row",
      rowId: row.id,
      commandKind: row.kind,
      runId: row.runId,
      threadId: row.threadId,
      requesterReplica: row.requesterReplica,
    });
    ctx.metrics.commandsDelivered += 1;
    // Not sent (closed meanwhile): the row stays delivered; the next hello reconciles it.
    this.#host.send(frame);
  }

  async #failRunStart(row: CommandRow, outcome: CommandOutcome): Promise<void> {
    await this.#fail(row, outcome);
    if (row.runId !== null && !outcome.ok) await this.#endRun(row.runId, row.threadId, outcome);
  }

  async #endRun(runId: string, threadId: string, outcome: CommandOutcome): Promise<void> {
    const { teamId } = this.#host.target;
    const end = outcome.ok
      ? ({ status: "completed" } as const)
      : ({ status: "failed", error: outcome.error } as const);
    const { ended } = await withAppendTx(this.#ctx.db, teamId, (tx) =>
      endRunInTx(tx, teamId, runId, end),
    );
    this.#host.endLease(runId);
    if (ended) this.#ctx.runEnded({ teamId, runId, threadId, status: end.status });
  }

  async #record(issued: Extract<IssuedCommand, { kind: "row" }>, outcome: CommandOutcome) {
    const { teamId } = this.#host.target;
    await withTeam(this.#ctx.db, teamId, (tx) =>
      completeCommand(tx, this.#ctx.bus, teamId, issued.rowId, outcome, this.#host.id),
    );
    if (issued.requesterReplica === this.#ctx.replicaId) this.#ctx.localResult(issued.rowId);
    if (issued.commandKind !== "run.start" || issued.runId === null) return;
    // A rejected prompt, or one Pi handled without starting work, ends the run without
    // `agent_settled` (KOBE-23).
    const handled =
      outcome.ok &&
      (outcome.data as { disposition?: unknown } | undefined)?.disposition === "handled";
    if (!outcome.ok || handled) await this.#endRun(issued.runId, issued.threadId, outcome);
  }
}
