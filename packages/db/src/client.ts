import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import pg from "pg";
import * as schema from "./schema/index.js";

export type KobeDb = NodePgDatabase<typeof schema>;
export type KobeTx = Parameters<Parameters<KobeDb["transaction"]>[0]>[0];

export interface KobeDatabase {
  readonly db: KobeDb;
  readonly pool: pg.Pool;
  close(): Promise<void>;
}

export interface CreateDbOptions {
  /** Pool size (default 10). */
  readonly max?: number;
  /** How long to wait for a free pooled connection before failing (default 10 s). */
  readonly acquireTimeoutMs?: number;
}

/** Connects as the app role. Team data is reachable only through `withTeam()`. */
export function createDb(connectionString: string, options: CreateDbOptions = {}): KobeDatabase {
  const pool = new pg.Pool({
    connectionString,
    max: options.max ?? 10,
    connectionTimeoutMillis: options.acquireTimeoutMs ?? 10_000,
  });
  const db = drizzle({ client: pool, schema, casing: "snake_case" });
  return { db, pool, close: () => pool.end() };
}
