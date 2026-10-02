import { sql, withTeam, type KobeDb } from "@kobe/db";
import type { SandboxBus } from "./bus.js";
import type { SandboxTarget } from "./types.js";

/** What the registry needs from a connection. */
export interface RegisteredConnection {
  readonly id: string;
  readonly target: SandboxTarget;
  readonly sandboxId: string;
  close(reason: "replaced" | "unauthorized" | "internal", message: string): void;
  /** Deliver pending commands now (a hint or a resync arrived). */
  pokeCommands(): void;
}

const key = (t: SandboxTarget) => `${t.teamId}:${t.userId}`;

/**
 * Connections held by this replica, and their rows in `sandbox_connections` (the cross-replica
 * record). One connection per (team, user) sandbox: registering a new one replaces the old one
 * wherever it lives (locally closed with `replaced`, remotely via a `kick` hint).
 */
export class ConnectionRegistry {
  readonly #db: KobeDb;
  readonly #bus: SandboxBus;
  readonly #replicaId: string;
  readonly #byId = new Map<string, RegisteredConnection>();
  readonly #bySandbox = new Map<string, RegisteredConnection>();

  constructor(db: KobeDb, bus: SandboxBus, replicaId: string) {
    this.#db = db;
    this.#bus = bus;
    this.#replicaId = replicaId;
  }

  get size(): number {
    return this.#byId.size;
  }

  get(connectionId: string): RegisteredConnection | undefined {
    return this.#byId.get(connectionId);
  }

  all(): RegisteredConnection[] {
    return [...this.#byId.values()];
  }

  /** Makes `conn` the sandbox's live connection (after a valid `hello`). */
  async register(conn: RegisteredConnection): Promise<void> {
    const { teamId, userId } = conn.target;
    const previous = await withTeam(this.#db, teamId, async (tx) => {
      const old = await tx.execute<{ connection_id: string; closed_at: Date | null }>(sql`
        SELECT connection_id, closed_at FROM sandbox_connections
         WHERE team_id = ${teamId} AND user_id = ${userId} FOR UPDATE`);
      await tx.execute(sql`
        INSERT INTO sandbox_connections
          (team_id, user_id, sandbox_id, connection_id, replica_id, connected_at, last_seen_at, closed_at)
        VALUES (${teamId}, ${userId}, ${conn.sandboxId}, ${conn.id}, ${this.#replicaId}, now(), now(), NULL)
        ON CONFLICT (team_id, user_id) DO UPDATE
          SET sandbox_id = EXCLUDED.sandbox_id, connection_id = EXCLUDED.connection_id,
              replica_id = EXCLUDED.replica_id, connected_at = now(), last_seen_at = now(),
              closed_at = NULL`);
      const row = old.rows[0];
      if (row && row.closed_at === null && row.connection_id !== conn.id) {
        await this.#bus.notifyInTx(tx, { kind: "kick", id: row.connection_id });
        return row.connection_id;
      }
      return undefined;
    });
    const local = this.#bySandbox.get(key(conn.target));
    this.#byId.set(conn.id, conn);
    this.#bySandbox.set(key(conn.target), conn);
    if (local && local !== conn) local.close("replaced", "a newer connection of this sandbox");
    if (previous && previous !== local?.id) this.#byId.get(previous)?.close("replaced", "replaced");
  }

  /** Forgets `conn` here and marks its row closed (if it is still the sandbox's connection). */
  async unregister(conn: RegisteredConnection): Promise<void> {
    this.#byId.delete(conn.id);
    if (this.#bySandbox.get(key(conn.target)) === conn) this.#bySandbox.delete(key(conn.target));
    await withTeam(this.#db, conn.target.teamId, (tx) =>
      tx.execute(sql`
        UPDATE sandbox_connections SET closed_at = now()
         WHERE team_id = ${conn.target.teamId} AND user_id = ${conn.target.userId}
           AND connection_id = ${conn.id} AND closed_at IS NULL`),
    );
  }

  /** Heartbeat of the row; false when the row no longer names this connection (replaced). */
  async touch(conn: RegisteredConnection): Promise<boolean> {
    const res = await withTeam(this.#db, conn.target.teamId, (tx) =>
      tx.execute(sql`
        UPDATE sandbox_connections SET last_seen_at = now()
         WHERE team_id = ${conn.target.teamId} AND user_id = ${conn.target.userId}
           AND connection_id = ${conn.id} AND closed_at IS NULL`),
    );
    return res.rowCount === 1;
  }

  /** Every connection of a user on this replica (deactivation). */
  forUser(userId: string): RegisteredConnection[] {
    return this.all().filter((c) => c.target.userId === userId);
  }
}
