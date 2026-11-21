import { randomUUID } from "node:crypto";
import type { PiGetEntriesData, ServerToSandboxFrame, RunStartFrame } from "@kobe/protocol";
import { withTeam, type SandboxCommandKind } from "@kobe/db";
import type { Logger } from "pino";
import { recordRunMemory } from "../memory/items/run-records.js";
import { markTold } from "../sync-conflicts/store.js";
import { completeCommand, pendingCommands, type CommandRow } from "./commands.js";
import type { WireContext } from "./context.js";
import { claimDelivery, type Claimed } from "./delivery/claim.js";
import { frameFor, traceContext, wireFrame, type DeliverableFrame } from "./delivery/frames.js";
import type { MemoryRecord } from "./delivery/memory-plan.js";
import { deliveryRefusal, failure } from "./delivery/preflight.js";
import { prepareRunStart } from "./delivery/run-start.js";
import {
  endRun,
  recordResult,
  tamperedMidRun,
  tampered,
  type SettleEnv,
} from "./delivery/settle.js";
import {
  lastMirroredEntryId,
  mirrorEntriesInTx,
  parseGetEntries,
  restoreParts,
  threadHasConversation,
} from "./entries.js";
import {
  COMMAND_FAILURES,
  isSummaryCommand,
  startsRun,
  type CommandOutcome,
  type SandboxTarget,
} from "./types.js";

export { withoutAppCards } from "./delivery/run-start.js";

/** What delivery needs from its connection. */
export interface DeliveryHost {
  readonly id: string;
  readonly target: SandboxTarget;
  readonly sandboxId: string;
  readonly ready: boolean;
  readonly log: Logger;
  send(frame: ServerToSandboxFrame): boolean;
  hasLiveLease(runId: string): boolean;
  /** The run was leased to this connection (it may have ended since). */
  hasLease(runId: string): boolean;
  /** The thread's message runs with a live lease on this connection (compactions left out). */
  liveMessageRuns(threadId: string): readonly string[];
  /** The agent advertised this optional feature in `hello.capabilities` (KOBE-82). */
  hasCapability(name: string): boolean;
  /** `compaction`: a compaction run's lease (KOBE-213; no tool frames may name it). */
  leaseRun(
    runId: string,
    threadId: string,
    cursor: number,
    compaction?: boolean,
    startedAt?: Date | null,
  ): void;
  /** The run's start went out with a trace context naming `commandSpanId` (KOBE-274). */
  traceStarted(runId: string, commandSpanId: string): void;
  leaseThread(threadId: string): void;
  endLease(runId: string): void;
  /** The sandbox has a newer connection: stop and close. */
  replaced(): void;
}

/** A `notebook.execute` in flight (KOBE-464): whose outputs its `notebook.output` frames are. */
export interface NotebookExec {
  readonly runId: string;
  readonly threadId: string;
  readonly execId: string;
}

export type IssuedCommand =
  | {
      readonly kind: "row";
      readonly rowId: string;
      readonly commandKind: SandboxCommandKind;
      readonly runId: string | null;
      readonly threadId: string;
      readonly requesterReplica: string;
      readonly notebook?: NotebookExec;
    }
  | {
      readonly kind: "internal";
      readonly resolve: (outcome: CommandOutcome) => void;
      readonly notebook?: NotebookExec;
    };

const ANSWERED_MAX = 4_096;
const DRAIN_BATCH = 20;

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
  /** Sync conflicts a `run.start` carried, marked told when it is accepted (KOBE-492). */
  readonly #conflictNotes = new WeakMap<IssuedCommand, readonly string[]>();
  /** Semantic memory a `run.start` carried, recorded once the sandbox accepts it (KOBE-382). */
  readonly #memoryRecords = new WeakMap<IssuedCommand, MemoryRecord>();
  /** What the `delivery/` helpers get (settlement also fetches entries). */
  readonly #env: SettleEnv;
  #draining = false;
  #again = false;
  #closed = false;

  constructor(ctx: WireContext, host: DeliveryHost) {
    this.#ctx = ctx;
    this.#host = host;
    this.#env = { ctx, host, fetchNewEntries: (threadId) => this.fetchNewEntries(threadId) };
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

  /** The issued command without taking it (a `notebook.output` names its running command). */
  peekIssued(commandId: string): IssuedCommand | "answered" | undefined {
    const issued = this.#issued.get(commandId);
    if (issued === undefined) return this.#answered.has(commandId) ? "answered" : undefined;
    return issued;
  }

  /**
   * A `notebook.execute` for a run leased on this connection (the agent's `run_python`, KOBE-464):
   * sent on this connection only, no command row. Resolves with the sandbox's answer.
   */
  notebookExecute(
    frame: Extract<ServerToSandboxFrame, { type: "notebook.execute" }>,
    timeoutMs: number,
  ): Promise<CommandOutcome> {
    return this.#internal(frame, timeoutMs, {
      runId: frame.run_id,
      threadId: frame.thread_id,
      execId: frame.exec_id,
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
    this.#conflictsTold(issued, outcome);
    this.#memoryRecorded(issued, outcome);
    if (issued.kind === "internal") {
      issued.resolve(outcome);
      return;
    }
    void recordResult(this.#env, issued, outcome).catch((err: unknown) =>
      this.#host.log.error({ err, kind: issued.commandKind }, "could not record a command result"),
    );
  }

  /** Server-initiated stop of a run the server has already ended (storage cap). Best effort. */
  stopRun(runId: string, threadId: string): void {
    void this.#internal(
      {
        v: 1,
        type: "run.stop",
        command_id: randomUUID(),
        run_id: runId,
        thread_id: threadId,
        mode: "abort",
        // The contract's closest reason: a resource budget of the run is exhausted.
        reason: "budget_exhausted",
      },
      this.#ctx.tuning.commandTimeoutMs["run.stop"],
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

  #internal(
    frame: ServerToSandboxFrame,
    timeoutMs = this.#ctx.tuning.internalCommandTimeoutMs,
    notebook?: NotebookExec,
  ): Promise<CommandOutcome> {
    if (this.#closed) return Promise.resolve(failure(COMMAND_FAILURES.connectionLost, "closed"));
    const commandId = "command_id" in frame ? frame.command_id : randomUUID();
    return new Promise<CommandOutcome>((resolve) => {
      const timer = setTimeout(() => {
        // A result arriving after the timeout is late, not a lease violation.
        this.takeIssued(commandId);
        resolve(failure(COMMAND_FAILURES.timeout, "the sandbox did not answer in time"));
      }, timeoutMs);
      timer.unref();
      this.#issued.set(commandId, {
        kind: "internal",
        resolve: (outcome) => {
          clearTimeout(timer);
          resolve(outcome);
        },
        ...(notebook === undefined ? {} : { notebook }),
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

  /**
   * `get_entries since`; when Pi no longer knows the cursor while Postgres holds no conversation
   * yet, Pi's whole session (KOBE-258: setup entries an older agent reported before Pi had written
   * them, then a new Pi made other ones). Restoring would overwrite Pi's real session with
   * nothing, so it is adopted: its entries are new roots next to the stale ones.
   */
  async #entriesSince(threadId: string, since: string | undefined): Promise<CommandOutcome> {
    const outcome = await this.#getEntries(threadId, since);
    if (outcome.ok || since === undefined || outcome.error.code !== "pi_rejected") return outcome;
    const { teamId } = this.#host.target;
    const conversation = await withTeam(this.#ctx.db, teamId, (tx) =>
      threadHasConversation(tx, teamId, threadId),
    );
    if (conversation) return outcome;
    this.#host.log.warn(
      { thread_id: threadId, error: outcome.error.message.slice(0, 300) },
      "Pi lost the mirrored cursor of a thread without a conversation; adopting its session",
    );
    return this.#getEntries(threadId, undefined);
  }

  /** New entries of a thread since the last mirrored one; undefined when unavailable. */
  async fetchNewEntries(threadId: string): Promise<PiGetEntriesData | undefined> {
    const { teamId } = this.#host.target;
    const since = await withTeam(this.#ctx.db, teamId, (tx) =>
      lastMirroredEntryId(tx, teamId, threadId),
    );
    const outcome = await this.#entriesSince(threadId, since);
    if (!outcome.ok) {
      // The sandbox's text is untrusted: logged (capped), never shown.
      this.#host.log.warn(
        {
          thread_id: threadId,
          code: outcome.error.code,
          error: outcome.error.message.slice(0, 300),
        },
        "entry sync failed",
      );
      if (tampered(outcome)) await tamperedMidRun(this.#env, threadId, outcome);
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
    const outcome = await this.#entriesSince(threadId, since);
    if (outcome.ok) {
      const data = parseGetEntries(outcome.data);
      if (data) {
        const mirrored = await withTeam(db, teamId, (tx) =>
          mirrorEntriesInTx(tx, teamId, threadId, data, this.#ctx.tuning.threadMaxEntries),
        );
        if (mirrored.capped) {
          this.#host.log.warn({ thread_id: threadId }, "thread entry cap reached");
          this.#ctx.auditLimit(this.#host.target, this.#host.sandboxId, "thread_entries");
        }
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
    this.#host.log.warn(
      { thread_id: threadId, error: outcome.error.message.slice(0, 300) },
      "Pi session lost; restoring from Postgres",
    );
    let part = 0;
    for await (const { entries, final } of restoreParts(db, teamId, threadId)) {
      const restored = await this.#internal({
        v: 1,
        type: "session.restore",
        command_id: randomUUID(),
        thread_id: threadId,
        part,
        final,
        entries,
      });
      if (!restored.ok) return restored;
      part += 1;
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

  async #deliver(row: CommandRow): Promise<void> {
    const commandId = randomUUID();
    const frame = frameFor(row, commandId);
    if (!frame) {
      await this.#fail(row, failure("invalid_command", "the stored command is not a valid frame"));
      return;
    }
    if (!(await this.#deliverable(row, frame))) return;
    const starts = startsRun(row.kind);
    const claimed = await claimDelivery(this.#env, row, starts);
    if (claimed === "gone") return; // expired or taken meanwhile
    if (claimed === "replaced") {
      this.#host.replaced();
      return;
    }
    if (claimed === "run_not_active") {
      await this.#fail(row, failure("run_not_active", "the run is not active"));
      return;
    }
    await this.#issue(row, commandId, frame, claimed, starts);
  }

  /** The agent can take the command and the thread's session is in place; else it is answered. */
  async #deliverable(row: CommandRow, frame: DeliverableFrame): Promise<boolean> {
    const refused = deliveryRefusal(this.#env, row, frame);
    if (refused) {
      await (refused.endsRun
        ? this.#failRunStart(row, refused.outcome)
        : this.#fail(row, refused.outcome));
      return false;
    }
    // After a wake the thread's session may be missing: restore it first, as for a run start.
    if (row.kind === "thread.context") {
      const session = await this.#ensureSession(row.threadId);
      if (!session.ok) {
        await this.#fail(row, failure(COMMAND_FAILURES.sessionUnavailable, session.error.message));
        return false;
      }
    }
    // KOBE-409 review M1: the memory query embedding runs beside the session restore and the
    // claim (usually started already when the message was accepted, on the replica that took it).
    const { teamId, userId } = this.#host.target;
    if (
      row.kind === "run.start" &&
      row.runId !== null &&
      this.#host.target.evalThreadId === undefined
    ) {
      this.#ctx.memoryEmbeddings?.prefetchQuery?.({
        teamId,
        userId,
        threadId: row.threadId,
        runId: row.runId,
        message: (frame as RunStartFrame).message,
      });
    }
    if (!startsRun(row.kind)) return true;
    const session = await this.#ensureSession(row.threadId);
    if (session.ok) return true;
    await this.#failRunStart(
      row,
      failure(COMMAND_FAILURES.sessionUnavailable, session.error.message),
    );
    return false;
  }

  /** A claimed command: leased, remembered as issued under `commandId`, and sent. */
  async #issue(
    row: CommandRow,
    commandId: string,
    frame: DeliverableFrame,
    claimed: Claimed,
    starts: boolean,
  ): Promise<void> {
    if (starts && row.runId !== null) {
      this.#host.leaseRun(
        row.runId,
        row.threadId,
        claimed.cursor,
        isSummaryCommand(row.kind),
        claimed.startedAt,
      );
    }
    const traced = starts ? traceContext(this.#env, row, frame) : undefined;
    this.#host.leaseThread(row.threadId);
    const execId = (frame as { exec_id?: unknown }).exec_id;
    this.#issued.set(commandId, {
      kind: "row",
      rowId: row.id,
      commandKind: row.kind,
      runId: row.runId,
      threadId: row.threadId,
      requesterReplica: row.requesterReplica,
      ...(row.kind === "notebook.execute" && row.runId !== null && typeof execId === "string"
        ? { notebook: { runId: row.runId, threadId: row.threadId, execId } }
        : {}),
    });
    this.#ctx.metrics.commandsDelivered += 1;
    // Not sent (closed meanwhile): the row stays delivered; the next hello reconciles it.
    const wire = wireFrame(row, frame, claimed, traced, starts);
    const out =
      row.kind === "run.start"
        ? await prepareRunStart(this.#env, row, frame as RunStartFrame, wire, {
            recordMemory: (pending) => {
              const issued = this.#issued.get(commandId);
              if (issued !== undefined) this.#memoryRecords.set(issued, pending);
            },
            conflictsCarried: (ids) => {
              const issued = this.#issued.get(commandId);
              if (issued !== undefined) this.#conflictNotes.set(issued, ids);
            },
          })
        : wire;
    this.#host.send(out);
  }

  /** A `run.start` that carried sync conflicts was accepted: they are told now (KOBE-492). */
  #conflictsTold(issued: IssuedCommand, outcome: CommandOutcome): void {
    const ids = this.#conflictNotes.get(issued);
    if (ids === undefined) return;
    this.#conflictNotes.delete(issued);
    if (!outcome.ok) return;
    const { teamId, userId } = this.#host.target;
    void markTold(this.#ctx.db, { teamId, userId }, ids).catch((err: unknown) =>
      this.#host.log.warn({ err }, "sync conflicts could not be marked told"),
    );
  }

  /** A `run.start` that carried freshly picked memories was accepted: record them (KOBE-382). */
  #memoryRecorded(issued: IssuedCommand, outcome: CommandOutcome): void {
    const pending = this.#memoryRecords.get(issued);
    if (pending === undefined) return;
    this.#memoryRecords.delete(issued);
    if (!outcome.ok) return;
    const { teamId } = this.#host.target;
    void withTeam(this.#ctx.db, teamId, (tx) =>
      recordRunMemory(tx, teamId, pending.runId, pending.items),
    ).catch((err: unknown) => this.#host.log.warn({ err }, "run memory records not written"));
  }

  async #failRunStart(row: CommandRow, outcome: CommandOutcome): Promise<void> {
    await this.#fail(row, outcome);
    if (row.runId !== null && !outcome.ok)
      await endRun(this.#env, row.runId, row.threadId, outcome);
  }
}
