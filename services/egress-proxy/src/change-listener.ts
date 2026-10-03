import {
  CEILING_CHANGED,
  EGRESS_CHANGES_CHANNEL,
  EGRESS_USER_HINT_PREFIX as USER_PREFIX,
} from "@kobe/db";
import pg from "pg";
import type { Logger } from "pino";
import type { AllowlistCache } from "./allowlist.js";
import type { TunnelScope } from "./tunnel-registry.js";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Applies one change hint — `<team uuid>`, `ceiling`, or `user:<uuid>` (membership removed or user
 * deactivated) — and returns its scope; anything else flushes everything.
 */
export function applyChangeHint(cache: AllowlistCache, payload: string | undefined): TunnelScope {
  if (payload === CEILING_CHANGED) {
    cache.invalidateCeiling();
    return { kind: "ceiling" };
  }
  if (payload !== undefined && UUID.test(payload)) {
    const teamId = payload.toLowerCase();
    cache.invalidateTeam(teamId);
    return { kind: "team", teamId };
  }
  if (payload?.startsWith(USER_PREFIX) && UUID.test(payload.slice(USER_PREFIX.length))) {
    const userId = payload.slice(USER_PREFIX.length).toLowerCase();
    cache.invalidateUser(userId);
    return { kind: "user", userId };
  }
  cache.invalidateAll();
  return { kind: "all" };
}

export interface ChangeListenerOptions {
  readonly connectionString: string;
  readonly cache: AllowlistCache;
  readonly logger: Logger;
  readonly reconnectMinMs?: number;
  readonly reconnectMaxMs?: number;
  readonly pingMs?: number;
  /** Called after each hint (and after a reconnect, scope "all"): re-check open tunnels. */
  readonly onChange?: (scope: TunnelScope) => void;
}

/**
 * One LISTEN connection per proxy process on {@link EGRESS_CHANGES_CHANNEL} (no Redis). After every
 * (re)connect the whole cache is dropped, because hints may have been missed; while disconnected
 * the cache runs on its short degraded TTL. A periodic ping detects half-open connections.
 */
export class ChangeListener {
  private client: pg.Client | undefined;
  private attempt = 0;
  private timer: NodeJS.Timeout | undefined;
  private ping: NodeJS.Timeout | undefined;
  private closed = false;

  constructor(private readonly options: ChangeListenerOptions) {}

  get listening(): boolean {
    return this.client !== undefined;
  }

  start(): void {
    void this.connect();
  }

  private async connect(): Promise<void> {
    if (this.closed) return;
    const { cache, logger } = this.options;
    const client = new pg.Client({
      connectionString: this.options.connectionString,
      connectionTimeoutMillis: 10_000,
    });
    client.on("error", (err) => {
      logger.warn({ err }, "egress change listener error");
      this.lost(client);
    });
    client.on("end", () => this.lost(client));
    client.on("notification", (n) => {
      if (n.channel !== EGRESS_CHANGES_CHANNEL) return;
      // Invalidate first, unconditionally: `onChange?.(applyChangeHint(…))` would skip the
      // invalidation itself when no callback is set.
      const scope = applyChangeHint(cache, n.payload);
      this.options.onChange?.(scope);
    });
    try {
      await client.connect();
      await client.query(`LISTEN ${EGRESS_CHANGES_CHANNEL}`);
      if (this.closed) {
        await client.end();
        return;
      }
      this.client = client;
      this.attempt = 0;
      cache.invalidateAll();
      cache.setListening(true);
      this.options.onChange?.({ kind: "all" });
      this.ping = setInterval(() => {
        client.query("SELECT 1").catch(() => this.lost(client));
      }, this.options.pingMs ?? 30_000);
      this.ping.unref();
      logger.info("listening for egress allowlist changes");
    } catch (err) {
      logger.warn({ err }, "egress change listener could not connect");
      this.lost(client);
    }
  }

  private lost(client: pg.Client): void {
    if (this.client !== undefined && this.client !== client) return;
    if (this.client === undefined && this.timer !== undefined) return;
    this.client = undefined;
    if (this.ping) clearInterval(this.ping);
    this.options.cache.setListening(false);
    this.options.cache.invalidateAll();
    client.end().catch(() => undefined);
    if (this.closed) return;
    const min = this.options.reconnectMinMs ?? 250;
    const max = this.options.reconnectMaxMs ?? 10_000;
    const delay = Math.min(max, min * 2 ** this.attempt++) * (0.5 + Math.random() / 2);
    this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.connect();
    }, delay);
    this.timer.unref();
  }

  async close(): Promise<void> {
    this.closed = true;
    if (this.timer) clearTimeout(this.timer);
    if (this.ping) clearInterval(this.ping);
    const client = this.client;
    this.client = undefined;
    await client?.end().catch(() => undefined);
  }
}
