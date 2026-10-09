import { sql, type KobeDb } from "@kobe/db";
import type { ForwardDestination } from "./types.js";

/** Cursor and health of one destination, kept in `install_settings` (one row, written atomically). */
export interface ForwardState {
  /** Every event up to and including this `seq` was delivered. */
  readonly seq: number;
  readonly delivered: number;
  /** Failed attempts in a row; 0 when the last attempt worked. */
  readonly failures: number;
  readonly nextAttemptAt: string | null;
  readonly lastSuccessAt: string | null;
  readonly lastErrorAt: string | null;
  readonly lastError: string | null;
}

export const stateKey = (name: ForwardDestination) => `audit.forward.${name}`;

export function initialState(seq: number): ForwardState {
  return {
    seq,
    delivered: 0,
    failures: 0,
    nextAttemptAt: null,
    lastSuccessAt: null,
    lastErrorAt: null,
    lastError: null,
  };
}

function parseState(value: string | undefined): ForwardState | null {
  if (!value) return null;
  try {
    const raw = JSON.parse(value) as Partial<ForwardState>;
    if (typeof raw.seq !== "number" || !Number.isInteger(raw.seq) || raw.seq < 0) return null;
    return { ...initialState(raw.seq), ...raw };
  } catch {
    return null;
  }
}

export async function readState(
  db: KobeDb,
  name: ForwardDestination,
): Promise<ForwardState | null> {
  const { rows } = await db.execute<{ value: string }>(
    sql`SELECT value FROM public.install_settings WHERE key = ${stateKey(name)}`,
  );
  return parseState(rows[0]?.value);
}

export async function writeState(
  db: KobeDb,
  name: ForwardDestination,
  state: ForwardState,
): Promise<void> {
  await db.execute(sql`
    INSERT INTO public.install_settings (key, value) VALUES (${stateKey(name)}, ${JSON.stringify(state)})
    ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = now()`);
}

export async function auditHeadSeq(db: KobeDb): Promise<number> {
  const { rows } = await db.execute<{ head: string | null }>(
    sql`SELECT max(seq)::text AS head FROM public.audit_log`,
  );
  return Number(rows[0]?.head ?? 0);
}

/** Consecutive failures after which a destination is reported as failing, not just retrying. */
export const FAILING_AFTER = 5;

export type ForwardStatus = "ok" | "retrying" | "failing" | "pending";

export interface DestinationHealth extends Partial<ForwardState> {
  readonly destination: ForwardDestination;
  readonly status: ForwardStatus;
  /** Events recorded but not yet delivered. */
  readonly behind: number | null;
}

export interface ForwardingHealth {
  /** False when no destination is configured. */
  readonly enabled: boolean;
  readonly head: number;
  readonly destinations: DestinationHealth[];
}

/** What the admin health view shows: per configured destination, cursor, lag and last failure. */
export async function readForwardingHealth(
  db: KobeDb,
  configured: readonly ForwardDestination[],
): Promise<ForwardingHealth> {
  const head = await auditHeadSeq(db);
  const destinations: DestinationHealth[] = [];
  for (const destination of configured) {
    const state = await readState(db, destination);
    if (!state) {
      destinations.push({ destination, status: "pending", behind: null });
      continue;
    }
    const status: ForwardStatus =
      state.failures === 0 ? "ok" : state.failures >= FAILING_AFTER ? "failing" : "retrying";
    destinations.push({ destination, status, behind: Math.max(0, head - state.seq), ...state });
  }
  return { enabled: configured.length > 0, head, destinations };
}
