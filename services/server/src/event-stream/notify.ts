import { z } from "zod";

/**
 * Fan-out hint channel (spec D16, CLAUDE.md "No Redis"). A NOTIFY on this channel says only "run X
 * has events up to seq N"; readers always re-read `run_events` from Postgres under their own team's
 * RLS, so the hint is never trusted for content and a lost or forged hint costs at most one extra
 * read. Payloads carry ids only: any session on the database can LISTEN on any channel, so no team
 * content, titles or text ever go into a notification.
 */
export const RUN_EVENTS_CHANNEL = "kobe_run_events";

export interface RunEventsHint {
  readonly runId: string;
  /** Highest seq committed by the notifying transaction. */
  readonly seq: number;
}

const uuid = z.uuid();

export function encodeHint(hint: RunEventsHint): string {
  return `${hint.runId}:${hint.seq}`;
}

/** Parses a notification payload; undefined for anything malformed (never throws). */
export function decodeHint(payload: string | undefined): RunEventsHint | undefined {
  if (payload === undefined || payload.length > 64) return undefined;
  const sep = payload.indexOf(":");
  if (sep < 0) return undefined;
  const runId = payload.slice(0, sep);
  const raw = payload.slice(sep + 1);
  if (!uuid.safeParse(runId).success || !/^[1-9][0-9]{0,15}$/.test(raw)) return undefined;
  const seq = Number(raw);
  return Number.isSafeInteger(seq) ? { runId: runId.toLowerCase(), seq } : undefined;
}

/**
 * Access hint (KOBE-221), on the same channel: "who may watch run X changed" (a share was revoked
 * or narrowed, the thread went to Trash or moved). Ids only, like {@link encodeHint}; the hub has
 * every open stream of that run recheck its viewer at once instead of at the next periodic
 * revalidation. A forged one costs one recheck.
 */
const ACCESS_PREFIX = "access:";

export function encodeAccessHint(runId: string): string {
  return `${ACCESS_PREFIX}${runId}`;
}

/** The run id of an access hint; undefined for anything else (never throws). */
export function decodeAccessHint(payload: string | undefined): string | undefined {
  if (payload === undefined || payload.length > 64 || !payload.startsWith(ACCESS_PREFIX)) {
    return undefined;
  }
  const runId = payload.slice(ACCESS_PREFIX.length);
  return uuid.safeParse(runId).success ? runId.toLowerCase() : undefined;
}
