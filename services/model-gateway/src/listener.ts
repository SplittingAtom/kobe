import { MODELS_CHANNEL, MODELS_KEYS_PREFIX } from "@kobe/db";
import pg from "pg";
import type { Logger } from "pino";
import type { PrincipalCache } from "./principals.js";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Applies one `kobe_models` hint to the cache: `keys:<team>` drops that team's entries. */
export function applyModelsHint(cache: PrincipalCache, payload: string | undefined): void {
  if (!payload?.startsWith(MODELS_KEYS_PREFIX)) return;
  const teamId = payload.slice(MODELS_KEYS_PREFIX.length);
  if (UUID.test(teamId)) cache.invalidateTeam(teamId.toLowerCase());
  else cache.invalidateAll();
}

/**
 * One LISTEN connection per shim process on `kobe_models` (no Redis): the gateway sync's
 * `keys:<team>` hints drop cached virtual keys at once. Without the listener the cache still
 * expires after its TTL; after a reconnect everything is dropped (hints may have been missed).
 */
export class ModelsListener {
  private client: pg.Client | undefined;
  private attempt = 0;
  private timer: NodeJS.Timeout | undefined;
  private ping: NodeJS.Timeout | undefined;
  private closed = false;

  constructor(
    private readonly options: {
      readonly connectionString: string;
      readonly cache: PrincipalCache;
      readonly logger: Logger;
    },
  ) {}

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
      logger.warn({ err }, "models listener error");
      this.lost(client);
    });
    client.on("end", () => this.lost(client));
    client.on("notification", (n) => {
      if (n.channel === MODELS_CHANNEL) applyModelsHint(cache, n.payload);
    });
    try {
      await client.connect();
      await client.query(`LISTEN ${MODELS_CHANNEL}`);
      if (this.closed) {
        await client.end();
        return;
      }
      this.client = client;
      this.attempt = 0;
      cache.invalidateAll();
      this.ping = setInterval(() => {
        client.query("SELECT 1").catch(() => this.lost(client));
      }, 30_000);
      this.ping.unref();
    } catch (err) {
      logger.warn({ err }, "models listener could not connect");
      this.lost(client);
    }
  }

  private lost(client: pg.Client): void {
    if (this.client !== undefined && this.client !== client) return;
    if (this.client === undefined && this.timer !== undefined) return;
    this.client = undefined;
    if (this.ping) clearInterval(this.ping);
    this.options.cache.invalidateAll();
    client.end().catch(() => undefined);
    if (this.closed) return;
    const delay = Math.min(10_000, 250 * 2 ** this.attempt++) * (0.5 + Math.random() / 2);
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
