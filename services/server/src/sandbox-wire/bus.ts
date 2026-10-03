import pg from "pg";
import { z } from "zod";
import { sql, type KobeDb, type KobeTx } from "@kobe/db";
import { logger as rootLogger } from "../logger.js";
import { SANDBOX_CHANNEL } from "./constants.js";

/**
 * Hints between replicas (spec D13: "server replicas route commands to whichever replica holds a
 * sandbox's socket via Postgres LISTEN/NOTIFY"; no Redis). A hint only says "look at Postgres":
 * payloads carry one id (any database session can LISTEN on any channel, so never team ids,
 * content or tokens), receivers re-read the row under their own team's RLS, and a lost or forged
 * hint costs at most a delay (every waiter also polls) or one extra read.
 */
export type BusHint =
  /** Commands are pending for this connection: its holder delivers them. */
  | { readonly kind: "cmd"; readonly id: string }
  /** This command has a result: its requester reads it. */
  | { readonly kind: "res"; readonly id: string }
  /** This connection was replaced by a newer one of the same sandbox: its holder closes it. */
  | { readonly kind: "kick"; readonly id: string }
  /** This user was deactivated or left a team: every replica re-checks their connections. */
  | { readonly kind: "user"; readonly id: string }
  /** This connection's sandbox was hibernated (KOBE-25): its holder closes it `hibernating`. */
  | { readonly kind: "hib"; readonly id: string }
  /** This approval left `pending` (KOBE-37): the broker waiting on it re-reads the row. */
  | { readonly kind: "apr"; readonly id: string };

const KINDS = new Set(["cmd", "res", "kick", "user", "hib", "apr"]);
const uuid = z.uuid();

export function encodeBusHint(hint: BusHint): string {
  return `${hint.kind}:${hint.id}`;
}

/** Never throws; undefined for anything that is not a well-formed hint. */
export function decodeBusHint(payload: string | undefined): BusHint | undefined {
  if (payload === undefined || payload.length > 64) return undefined;
  const sep = payload.indexOf(":");
  const kind = payload.slice(0, sep);
  const id = payload.slice(sep + 1);
  if (sep < 0 || !KINDS.has(kind) || !uuid.safeParse(id).success) return undefined;
  return { kind, id: id.toLowerCase() } as BusHint;
}

/** Queues a hint inside `tx` (delivered on commit) without a bus instance (any process). */
export async function notifyHintInTx(tx: KobeTx, hint: BusHint): Promise<void> {
  await tx.execute(sql`SELECT pg_notify(${SANDBOX_CHANNEL}, ${encodeBusHint(hint)})`);
}

export type BusState = "idle" | "connecting" | "listening" | "down" | "closed";

export interface SandboxBus {
  /** Starts listening (idempotent). */
  start(): void;
  /** Queues a hint inside `tx`: Postgres delivers it on commit, never for a rollback. */
  notifyInTx(tx: KobeTx, hint: BusHint): Promise<void>;
  /** Sends a hint now (outside any transaction). */
  notify(db: KobeDb, hint: BusHint): Promise<void>;
  readonly state: BusState;
  close(): Promise<void>;
}

export interface BusOptions {
  readonly connectionString: string;
  readonly onHint: (hint: BusHint) => void;
  /** Hints may have been missed (listener (re)connected or down): re-read everything. */
  readonly onResync: () => void;
  readonly reconnectMinMs: number;
  readonly reconnectMaxMs: number;
  readonly degradedPollMs?: number;
  readonly pingMs?: number;
  readonly pingTimeoutMs?: number;
}

/**
 * One dedicated LISTEN connection per server process on {@link SANDBOX_CHANNEL}, outside the query
 * pool (same design as the event-stream hub, KOBE-31: reconnect with jittered backoff, resync after
 * every (re)connect, poll while down, ping to catch half-open TCP). Needs a direct or session-mode
 * connection to Postgres.
 */
export function createSandboxBus(options: BusOptions): SandboxBus {
  const log = rootLogger.child({ component: "sandbox-bus" });
  const pollMs = options.degradedPollMs ?? 1_000;
  const pingMs = options.pingMs ?? 30_000;
  const pingTimeoutMs = options.pingTimeoutMs ?? 10_000;
  let state: BusState = "idle";
  let client: pg.Client | undefined;
  let attempt = 0;
  let reconnectTimer: NodeJS.Timeout | undefined;
  let pollTimer: NodeJS.Timeout | undefined;
  let pingTimer: NodeJS.Timeout | undefined;

  const safely = (fn: () => void) => {
    try {
      fn();
    } catch (err) {
      log.error({ err }, "sandbox bus handler failed");
    }
  };
  const resync = () => safely(options.onResync);

  const startPolling = () => {
    pollTimer ??= setInterval(resync, pollMs);
    pollTimer.unref();
  };
  const stopPolling = () => {
    if (pollTimer) clearInterval(pollTimer);
    pollTimer = undefined;
  };
  const stopPing = () => {
    if (pingTimer) clearInterval(pingTimer);
    pingTimer = undefined;
  };

  const scheduleReconnect = () => {
    if (state === "closed" || reconnectTimer) return;
    const base = Math.min(options.reconnectMaxMs, options.reconnectMinMs * 2 ** attempt);
    attempt += 1;
    reconnectTimer = setTimeout(
      () => {
        reconnectTimer = undefined;
        void connect();
      },
      Math.round(base / 2 + Math.random() * (base / 2)),
    );
    reconnectTimer.unref();
  };

  const lost = (lostClient: pg.Client, err?: unknown) => {
    if (lostClient !== client) return;
    client = undefined;
    stopPing();
    lostClient.removeAllListeners("notification");
    lostClient.end().catch(() => undefined);
    (
      lostClient as unknown as { connection?: { stream?: { destroy?: () => void } } }
    ).connection?.stream?.destroy?.();
    if (state === "closed") return;
    state = "down";
    log.warn({ err }, "sandbox bus LISTEN connection lost; polling until it is back");
    startPolling();
    resync();
    scheduleReconnect();
  };

  const connect = async (): Promise<void> => {
    if (state === "closed") return;
    state = "connecting";
    const next = new pg.Client({
      connectionString: options.connectionString,
      keepAlive: true,
      application_name: "kobe-sandbox-bus",
      query_timeout: pingTimeoutMs,
      connectionTimeoutMillis: pingTimeoutMs,
    });
    client = next;
    next.on("notification", (msg) => {
      if (msg.channel !== SANDBOX_CHANNEL) return;
      const hint = decodeBusHint(msg.payload);
      if (hint) safely(() => options.onHint(hint));
    });
    next.on("error", (err) => lost(next, err));
    next.on("end", () => lost(next));
    try {
      await next.connect();
      await next.query(`LISTEN ${SANDBOX_CHANNEL}`);
    } catch (err) {
      lost(next, err);
      return;
    }
    if ((state as BusState) === "closed" || client !== next) {
      await next.end().catch(() => undefined);
      return;
    }
    state = "listening";
    attempt = 0;
    stopPolling();
    pingTimer = setInterval(() => {
      next.query("SELECT 1").catch((err: unknown) => lost(next, err));
    }, pingMs);
    pingTimer.unref();
    resync();
  };

  return {
    get state() {
      return state;
    },
    start() {
      if (state !== "idle") return;
      startPolling();
      void connect();
    },
    async notifyInTx(tx, hint) {
      await notifyHintInTx(tx, hint);
    },
    async notify(db, hint) {
      await db.execute(sql`SELECT pg_notify(${SANDBOX_CHANNEL}, ${encodeBusHint(hint)})`);
    },
    async close() {
      if (state === "closed") return;
      state = "closed";
      stopPolling();
      stopPing();
      if (reconnectTimer) clearTimeout(reconnectTimer);
      const current = client;
      client = undefined;
      if (current) {
        current.removeAllListeners("notification");
        await current.end().catch(() => undefined);
      }
    },
  };
}
