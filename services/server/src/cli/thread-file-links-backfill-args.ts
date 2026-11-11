import { parseArgs } from "node:util";
import type { BackfillOptions } from "../thread-file-links/backfill.js";

/** `thread-file-links-backfill.js` arguments (KOBE-610), parsed apart from the run itself. */
export const BACKFILL_USAGE =
  "usage: thread-file-links-backfill.js [--restart] [--max <threads>] [--pace-ms <ms>]";

const MAX_PACE_MS = 60_000;

function count(raw: string | undefined, min: number, max: number): number | undefined {
  if (raw === undefined) return undefined;
  const n = /^\d+$/.test(raw) ? Number(raw) : Number.NaN;
  return Number.isSafeInteger(n) && n >= min && n <= max ? n : Number.NaN;
}

/** The options, or the usage line when the arguments are invalid. */
export function parseBackfillArgs(argv: readonly string[]): BackfillOptions | string {
  let values;
  try {
    ({ values } = parseArgs({
      args: [...argv],
      options: {
        restart: { type: "boolean" },
        max: { type: "string" },
        "pace-ms": { type: "string" },
      },
    }));
  } catch {
    return BACKFILL_USAGE;
  }
  const maxThreads = count(values.max, 1, Number.MAX_SAFE_INTEGER);
  const paceMs = count(values["pace-ms"], 0, MAX_PACE_MS);
  if (Number.isNaN(maxThreads) || Number.isNaN(paceMs)) return BACKFILL_USAGE;
  return {
    restart: values.restart === true,
    ...(maxThreads === undefined ? {} : { maxThreads }),
    ...(paceMs === undefined ? {} : { paceMs }),
  };
}
