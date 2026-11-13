import { sql, withTeam, type KobeDb, type KobeTx } from "@kobe/db";
import type { SemanticMemoryOverrides, SemanticMemoryScope } from "@kobe/protocol";
import { recordAudit, type ServerAuditEvent } from "../../audit/record.js";
import { readMemorySiteSettings, type MemorySiteSettings } from "../site-settings.js";
import { readSiteSwitches, readSwitches } from "../switches.js";
import { WORKSPACE_SWITCHES_ON, effectiveMemory, type EffectiveMemory } from "../switch-model.js";
import { checkMemoryWrite, type MemoryCheckOutcome } from "../checks.js";
import { MemoryItemError, notFound } from "./errors.js";
import { deliverSiteNotices, type PendingSiteNotices } from "./limits.js";
import { locate, type Location } from "./location.js";
import { readItem, type ItemRow } from "./rows.js";
import type { MemoryWho } from "./who.js";

type SQL = ReturnType<typeof sql>;

/** One store call: the scope's location, the switches and Site settings, in one transaction. */
export interface Op {
  readonly tx: KobeTx;
  readonly loc: Location;
  readonly who: MemoryWho;
  readonly memory: EffectiveMemory;
  readonly settings: MemorySiteSettings;
  /** Site curators to tell after commit (limits.ts). */
  pending: PendingSiteNotices;
}

/**
 * Runs `fn` in the Workspace's transaction (`withTeam`: Workspace rows under RLS; portable and Site
 * rows through the server's own filters in the same transaction), then sends any after-commit
 * notices.
 */
export async function inStore<T>(
  db: KobeDb,
  who: MemoryWho,
  scope: SemanticMemoryScope,
  fn: (op: Op) => Promise<T>,
): Promise<T> {
  let pending: PendingSiteNotices = [];
  const teamId = who.teamId;
  const body = async (tx: KobeTx) => {
    const op: Op = {
      tx,
      who,
      loc: locate(scope, teamId, who.userId),
      // Without a Workspace only the Site's switches apply (portable and Site requests).
      memory:
        teamId === null
          ? effectiveMemory(await readSiteSwitches(tx), WORKSPACE_SWITCHES_ON)
          : (await readSwitches(tx, teamId)).memory,
      settings: await readMemorySiteSettings(tx),
      pending: [],
    };
    const value = await fn(op);
    pending = op.pending;
    return value;
  };
  // Workspace rows need the team's transaction (RLS); portable and Site rows are site-wide.
  const out = teamId === null ? await db.transaction(body) : await withTeam(db, teamId, body);
  if (pending.length > 0) await deliverSiteNotices(db, pending);
  return out;
}

/** The item, row-locked for a write, or 404. */
export async function loadForWrite(op: Op, id: string): Promise<ItemRow> {
  const row = await readItem(op.tx, op.loc, id, true);
  if (!row) throw notFound();
  return row;
}

export function assertExpected(row: ItemRow, expected: number | undefined): void {
  if (expected !== undefined && expected !== row.current_version)
    throw new MemoryItemError(
      "memory_version_conflict",
      "This memory changed since you opened it. Reload it and try again.",
      { current_version: row.current_version },
    );
}

/**
 * The save checks every statement write of the item store runs (create, edit, a Policy change,
 * Undo, restore): `memory/checks.ts` ({@link checkMemoryWrite}, KOBE-379) with the
 * near-duplicate check (KOBE-378). `policy`: the item is (or becomes) Policy. `except`: the item
 * itself and any item the save replaces. `tags`: scanned for secrets.
 */
export function saveChecks(
  op: Op,
  subject: {
    statement: string;
    policy: boolean;
    except?: readonly string[];
    tags?: readonly string[];
  },
  overrides: SemanticMemoryOverrides | undefined,
): Promise<MemoryCheckOutcome> {
  return checkMemoryWrite(op, { scope: op.loc.scope, ...subject }, overrides);
}

/** Workspace items are audited in the team log; portable and Site items in the site log. */
export const auditTeam = (loc: Location): string | null => (loc.workspace ? loc.teamId : null);

export async function audit(op: Op, events: readonly ServerAuditEvent[]): Promise<void> {
  for (const e of events) await recordAudit(op.tx, e);
}

/** Tags as stored: trimmed, lowercased, duplicates dropped (order kept). */
export const normaliseTags = (tags: readonly string[]): string[] => [
  ...new Set(tags.map((t) => t.trim().toLowerCase())),
];

/** A `text[]` literal from bound values (drizzle expands a bare array into a list). */
export const textArray = (values: readonly string[]): SQL =>
  values.length === 0
    ? sql`'{}'::text[]`
    : sql`ARRAY[${sql.join(
        values.map((v) => sql`${v}`),
        sql`, `,
      )}]::text[]`;

export const sameTags = (a: readonly string[], b: readonly string[]) =>
  a.length === b.length && a.every((t, i) => t === b[i]);
