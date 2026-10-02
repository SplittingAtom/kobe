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
