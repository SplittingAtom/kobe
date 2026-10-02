import { randomUUID } from "node:crypto";
import pg from "pg";
import { logger as rootLogger } from "../logger.js";
import { decodeHint, RUN_EVENTS_CHANNEL } from "./notify.js";

/** What a stream hears from the hub. Every call means "re-read Postgres"; none carries content. */
export interface HubSubscriber {
  /** A transaction committed events of this run up to `seq`. */
  hint(seq: number): void;
  /** Notifications may have been missed (listener (re)connected or down): re-read now. */
  resync(): void;
  /** The hub is shutting down: end the stream so the client reconnects to another replica. */
  close(): void;
}

export interface RunEventHub {
  /** Starts listening (lazily, once) and registers a subscriber for one run. Returns unsubscribe. */
  subscribe(runId: string, subscriber: HubSubscriber): () => void;
  /** Reserves one of the user's concurrent stream slots on this replica; null when at the cap. */
  acquireSlot(userId: string): (() => void) | null;
  /** `listening` once the LISTEN connection is up. */
  readonly state: HubState;
  /** Number of subscribed streams (all runs). */
  readonly size: number;
  close(): Promise<void>;
}

export type HubState = "idle" | "connecting" | "listening" | "down" | "closed";

export interface HubOptions {
  /** App-role URL. Must reach Postgres directly or via a session-mode pooler (LISTEN is per session). */
  readonly connectionString: string;
  readonly maxStreamsPerUser?: number;
  readonly reconnectMinMs?: number;
  readonly reconnectMaxMs?: number;
  /** While the listener is down, subscribers re-read this often instead of waiting for hints. */
  readonly degradedPollMs?: number;
  /** Health check of the LISTEN connection (detects half-open TCP). */
  readonly pingMs?: number;
  /** A ping (or LISTEN, or the probe) not answered within this is a lost connection. */
  readonly pingTimeoutMs?: number;
  /** Resyncs after a (re)connect are spread over this window, one random delay per run. */
  readonly resyncJitterMs?: number;
}

export const HUB_DEFAULTS = {
  maxStreamsPerUser: 16,
  reconnectMinMs: 250,
  reconnectMaxMs: 10_000,
  degradedPollMs: 1_000,
  pingMs: 30_000,
  pingTimeoutMs: 10_000,
  resyncJitterMs: 1_000,
} as const;

const CONNECT_TIMEOUT_MS = 10_000;
const PROBE_PREFIX = "probe:";

/**
 * Postgres LISTEN/NOTIFY fan-out for one server process (spec D16, no Redis). Exactly one dedicated
 * connection per process listens on {@link RUN_EVENTS_CHANNEL}, however many streams are open, so
 * streams never exhaust connections; it lives outside the query pool so a stream never holds a
 * pool slot while idle. Notifications are only hints dispatched to the subscribers of that run;
 * after any (re)connect every subscriber resyncs, and while the listener is down subscribers are
 * polled, so a missed notification delays an event but never loses it.
 */
export function createRunEventHub(options: HubOptions): RunEventHub {
  const opts = { ...HUB_DEFAULTS, ...options };
  const log = rootLogger.child({ component: "run-event-hub" });
  const byRun = new Map<string, Set<HubSubscriber>>();
  const slots = new Map<string, number>();
  let state: HubState = "idle";
  let client: pg.Client | undefined;
  let attempt = 0;
  let reconnectTimer: NodeJS.Timeout | undefined;
  let pollTimer: NodeJS.Timeout | undefined;
  let pingTimer: NodeJS.Timeout | undefined;

  const each = (fn: (s: HubSubscriber) => void) => {
    for (const set of byRun.values()) for (const s of [...set]) fn(s);
  };

  /**
   * Every subscriber re-reads, spread over `windowMs` with one random delay per run: the watchers
   * of one run wake together (their reads coalesce into one query in the stream reader) while
   * different runs don't all hit the database in the same instant.
   */
  const resyncAll = (windowMs: number) => {
    for (const runId of byRun.keys()) {
      const fire = () => {
        const current = byRun.get(runId);
        if (current) for (const s of [...current]) s.resync();
      };
      if (windowMs <= 0) fire();
      else setTimeout(fire, Math.random() * windowMs).unref();
    }
  };

  let probe: { nonce: string; resolve: () => void } | undefined;

  const dispatch = (payload: string | undefined) => {
    if (payload?.startsWith(PROBE_PREFIX)) {
      if (probe && payload === PROBE_PREFIX + probe.nonce) probe.resolve();
      return;
    }
    const hint = decodeHint(payload);
    if (!hint) return;
    const set = byRun.get(hint.runId);
    if (set) for (const s of [...set]) s.hint(hint.seq);
  };

  const startPolling = () => {
    pollTimer ??= setInterval(() => resyncAll(opts.degradedPollMs), opts.degradedPollMs);
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
    const base = Math.min(opts.reconnectMaxMs, opts.reconnectMinMs * 2 ** attempt);
    const delay = Math.round(base / 2 + Math.random() * (base / 2));
    attempt += 1;
    reconnectTimer = setTimeout(() => {
      reconnectTimer = undefined;
      void connect();
    }, delay);
    reconnectTimer.unref();
  };

  const lost = (lostClient: pg.Client, err?: unknown) => {
    if (lostClient !== client) return;
    client = undefined;
    stopPing();
    lostClient.removeAllListeners("notification");
    lostClient.end().catch(() => undefined);
    // end() waits for the server, which never answers on a half-open socket: drop the socket too.
    (
      lostClient as unknown as { connection?: { stream?: { destroy?: () => void } } }
    ).connection?.stream?.destroy?.();
    if (state === "closed") return;
    state = "down";
    log.warn({ err }, "LISTEN connection lost; polling until it is back");
    startPolling();
    resyncAll(0);
    scheduleReconnect();
  };

  const connect = async (): Promise<void> => {
    if (state === "closed") return;
    state = "connecting";
    const next = new pg.Client({
      connectionString: opts.connectionString,
      keepAlive: true,
      application_name: "kobe-event-hub",
      query_timeout: opts.pingTimeoutMs,
      connectionTimeoutMillis: CONNECT_TIMEOUT_MS,
    });
    client = next;
    next.on("notification", (msg) => {
      if (msg.channel === RUN_EVENTS_CHANNEL) dispatch(msg.payload);
    });
    next.on("error", (err) => lost(next, err));
    next.on("end", () => lost(next));
    try {
      await next.connect();
      await next.query(`LISTEN ${RUN_EVENTS_CHANNEL}`);
      await probeDelivery(next);
    } catch (err) {
      lost(next, err);
      return;
    }
    // close() may have run while we were connecting.
    if ((state as HubState) === "closed" || client !== next) {
      await next.end().catch(() => undefined);
      return;
    }
    state = "listening";
    attempt = 0;
    stopPolling();
    pingTimer = setInterval(() => {
      next.query("SELECT 1").catch((err: unknown) => lost(next, err));
    }, opts.pingMs);
    pingTimer.unref();
    // Anything committed before LISTEN took effect was not heard: everyone re-reads once.
    resyncAll(opts.resyncJitterMs);
  };

  /**
   * Proves the session hears notifications: it notifies itself and waits for the echo. Behind a
   * transaction-mode pooler (PgBouncer `pool_mode=transaction`) LISTEN "succeeds" on some backend
   * and the echo never comes back; that is reported loudly and the hub stays in polling mode.
   */
  async function probeDelivery(c: pg.Client): Promise<void> {
    const nonce = randomUUID();
    let timer: NodeJS.Timeout | undefined;
    const heard = new Promise<void>((resolve, reject) => {
      probe = { nonce, resolve };
      timer = setTimeout(
        () =>
          reject(
            new Error(
              "LISTEN connection does not receive notifications: KOBE_DATABASE_URL must reach " +
                "Postgres directly or through a session-mode pooler (not transaction mode)",
            ),
          ),
        opts.pingTimeoutMs,
      );
    });
    try {
      await c.query(`SELECT pg_notify($1, $2)`, [RUN_EVENTS_CHANNEL, PROBE_PREFIX + nonce]);
      await heard;
    } finally {
      clearTimeout(timer);
      probe = undefined;
    }
  }

  return {
    get state() {
      return state;
    },
    get size() {
      let n = 0;
      for (const set of byRun.values()) n += set.size;
      return n;
    },
    subscribe(runId, subscriber) {
      if (state === "closed") {
        queueMicrotask(() => subscriber.close());
        return () => undefined;
      }
      const key = runId.toLowerCase();
      let set = byRun.get(key);
      if (!set) byRun.set(key, (set = new Set()));
      set.add(subscriber);
      if (state === "idle") {
        startPolling(); // until the first LISTEN is up
        void connect();
      }
      return () => {
        const current = byRun.get(key);
        if (!current) return;
        current.delete(subscriber);
        if (current.size === 0) byRun.delete(key);
      };
    },
    acquireSlot(userId) {
      const used = slots.get(userId) ?? 0;
      if (used >= opts.maxStreamsPerUser) return null;
      slots.set(userId, used + 1);
      let released = false;
      return () => {
        if (released) return;
        released = true;
        const n = (slots.get(userId) ?? 1) - 1;
        if (n <= 0) slots.delete(userId);
        else slots.set(userId, n);
      };
    },
    async close() {
      if (state === "closed") return;
      state = "closed";
      stopPolling();
      stopPing();
      if (reconnectTimer) clearTimeout(reconnectTimer);
      each((s) => s.close());
      byRun.clear();
      probe = undefined;
      const current = client;
      client = undefined;
      if (current) {
        current.removeAllListeners("notification");
        await current.end().catch(() => undefined);
      }
    },
  };
}
