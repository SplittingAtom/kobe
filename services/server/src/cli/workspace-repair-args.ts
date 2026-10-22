import { parseArgs } from "node:util";

/** `workspace-repair.js` arguments (KOBE-475), parsed and checked apart from the run itself. */
export const REPAIR_USAGE =
  "usage: workspace-repair.js [--dry-run] [--team-id <uuid> [--user-id <uuid>]] " +
  "[--max <workspaces>] [--pace-ms <ms>]";

export interface RepairArgs {
  readonly dryRun: boolean;
  readonly teamId?: string;
  readonly userId?: string;
  readonly maxWorkspaces?: number;
  readonly paceMs?: number;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const MAX_PACE_MS = 60_000;

/** A whole number in [min, max], or undefined when absent; NaN when invalid. */
function count(raw: string | undefined, min: number, max: number): number | undefined {
  if (raw === undefined) return undefined;
  const n = /^\d+$/.test(raw) ? Number(raw) : Number.NaN;
  return Number.isSafeInteger(n) && n >= min && n <= max ? n : Number.NaN;
}

/** The parsed arguments, or the usage line when they are invalid. */
export function parseRepairArgs(argv: readonly string[]): RepairArgs | string {
  let values;
  try {
    ({ values } = parseArgs({
      args: [...argv],
      options: {
        "dry-run": { type: "boolean" },
        "team-id": { type: "string" },
        "user-id": { type: "string" },
        max: { type: "string" },
        "pace-ms": { type: "string" },
      },
    }));
  } catch {
    return REPAIR_USAGE;
  }
  const teamId = values["team-id"];
  const userId = values["user-id"];
  const maxWorkspaces = count(values.max, 1, Number.MAX_SAFE_INTEGER);
  const paceMs = count(values["pace-ms"], 0, MAX_PACE_MS);
  const badId = [teamId, userId].some((id) => id !== undefined && !UUID.test(id));
  if (
    badId ||
    (userId !== undefined && teamId === undefined) ||
    Number.isNaN(maxWorkspaces) ||
    Number.isNaN(paceMs)
  ) {
    return REPAIR_USAGE;
  }
  return {
    dryRun: values["dry-run"] === true,
    ...(teamId === undefined ? {} : { teamId }),
    ...(userId === undefined ? {} : { userId }),
    ...(maxWorkspaces === undefined ? {} : { maxWorkspaces }),
    ...(paceMs === undefined ? {} : { paceMs }),
  };
}
