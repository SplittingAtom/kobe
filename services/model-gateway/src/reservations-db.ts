import { sql, type KobeDb } from "@kobe/db";
import {
  MEMBER_SHARE,
  type ReservationStore,
  type ReserveRequest,
  type ReserveVerdict,
} from "./reservations.js";

/**
 * Reservations in Postgres (KOBE-120), shared by every gateway replica. One statement each:
 * `kobe_reserve_budget` checks the live (unexpired) reservations and inserts under transaction
 * advisory locks, so two replicas cannot both take the last of a budget; `kobe_settle_budget`
 * deletes or shortens. A reservation carries an expiry, so a replica that crashes mid-call
 * frees its reservations by itself, and expired rows never count.
 */
export class DbReservations implements ReservationStore {
  constructor(
    private readonly db: KobeDb,
    /** `salt`: the per-install secret the functions hash team and member keys with. */
    private readonly options: { readonly ttlMs: number; readonly salt: string },
  ) {}

  async reserve(r: ReserveRequest): Promise<ReserveVerdict> {
    const lines = JSON.stringify(
      r.lines.map((l) => ({
        scope: l.scope,
        unit: l.unit,
        limit: l.limitExact ?? String(l.limit),
        spent: l.spentExact ?? String(l.spent),
      })),
    );
    const res = await this.db.execute<{ r: string }>(
      sql`SELECT kobe_reserve_budget(${r.teamId}::uuid, ${r.userId}::uuid, ${r.callId},
        ${r.cost.usd.toFixed(12)}::numeric, ${Math.ceil(r.cost.tokens)}::bigint,
        ${this.options.ttlMs}::integer, ${MEMBER_SHARE}::numeric, ${lines}::jsonb, ${this.options.salt}) AS r`,
    );
    return parseVerdict(res.rows[0]?.r);
  }

  async extend(teamId: string, callIds: readonly string[]): Promise<void> {
    if (callIds.length === 0) return;
    await this.db.execute(
      sql`SELECT kobe_extend_budget(${teamId}::uuid, ${pgArray(callIds)}::text[],
        ${this.options.ttlMs}::integer, ${this.options.salt})`,
    );
  }

  async end(teamId: string, callIds: readonly string[], keepMs?: number): Promise<void> {
    if (callIds.length === 0) return;
    const keep = keepMs === undefined ? null : Math.max(0, Math.round(keepMs));
    await this.db.execute(
      sql`SELECT kobe_settle_budget(${teamId}::uuid, ${pgArray(callIds)}::text[], ${keep}::integer, ${this.options.salt})`,
    );
  }
}

export function parseVerdict(text: string | undefined): ReserveVerdict {
  if (text === "ok") return { ok: true };
  const m = /^(full|own_share):(\d+)$/.exec(text ?? "");
  if (!m) throw new Error(`kobe_reserve_budget: unexpected answer ${JSON.stringify(text)}`);
  return { ok: false, verdict: m[1] as "full" | "own_share", line: Number(m[2]) };
}

/** A text[] literal; call ids are server-generated UUIDs, quotes and backslashes are dropped. */
const pgArray = (ids: readonly string[]): string =>
  `{${ids.map((id) => `"${id.replace(/["\\]/g, "")}"`).join(",")}}`;
