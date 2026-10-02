import {
  asc,
  count,
  egressDomains,
  eq,
  notifyEgressChanged,
  sql,
  type EgressPreset,
  type KobeDb,
} from "@kobe/db";
import { recordAudit } from "../audit/record.js";
import { MAX_CEILING_DOMAINS } from "./schemas.js";

/**
 * The install egress ceiling (spec D6, D28; `/v1/install/egress-ceiling`): which domains teams
 * may enable. Every change is audited and NOTIFYs the egress proxies in the same transaction.
 */
export interface CeilingEntry {
  readonly domain: string;
  readonly preset: EgressPreset | null;
  readonly in_ceiling: boolean;
  readonly note: string | null;
  readonly created_by: string | null;
  readonly created_at: string;
  readonly updated_at: string;
}

type Row = typeof egressDomains.$inferSelect;

const toEntry = (r: Row): CeilingEntry => ({
  domain: r.domain,
  preset: r.preset ?? null,
  in_ceiling: r.inCeiling,
  note: r.note,
  created_by: r.createdBy,
  created_at: r.createdAt.toISOString(),
  updated_at: r.updatedAt.toISOString(),
});

export async function listCeiling(db: KobeDb): Promise<CeilingEntry[]> {
  const rows = await db
    .select()
    .from(egressDomains)
    .orderBy(
      sql`${egressDomains.preset} IS NULL`,
      asc(egressDomains.preset),
      asc(egressDomains.domain),
    );
  return rows.map(toEntry);
}

export type AddResult =
  | { readonly ok: true; readonly entry: CeilingEntry; readonly created: boolean }
  | { readonly ok: false; readonly error: "already_in_ceiling" | "too_many_domains" };

/**
 * Adds a domain to the ceiling. A listed domain that is out of the ceiling (e.g. a git-host preset)
 * is put back in rather than duplicated.
 */
export async function addCeilingDomain(
  db: KobeDb,
  input: { readonly domain: string; readonly note?: string | null | undefined },
  userId: string,
): Promise<AddResult> {
  return db.transaction(async (tx) => {
    // Serializes concurrent adds so the cap holds (install-wide table, small).
    await tx.execute(sql`LOCK TABLE ${egressDomains} IN SHARE ROW EXCLUSIVE MODE`);
    const [existing] = await tx
      .select()
      .from(egressDomains)
      .where(eq(egressDomains.domain, input.domain));
    if (existing?.inCeiling) return { ok: false, error: "already_in_ceiling" };
    if (existing) {
      const [row] = await tx
        .update(egressDomains)
        .set({ inCeiling: true, updatedAt: new Date() })
        .where(eq(egressDomains.domain, input.domain))
        .returning();
      await notifyEgressChanged(tx, null);
      await recordAudit(tx, {
        action: "egress.ceiling.changed",
        target: { domain: input.domain, inCeiling: true },
      });
      return { ok: true, entry: toEntry(must(row)), created: false };
    }
    const [{ n } = { n: 0 }] = await tx.select({ n: count() }).from(egressDomains);
    if (n >= MAX_CEILING_DOMAINS) return { ok: false, error: "too_many_domains" };
    const [row] = await tx
      .insert(egressDomains)
      .values({
        domain: input.domain,
        inCeiling: true,
        note: input.note ?? null,
        createdBy: userId,
      })
      .returning();
    await notifyEgressChanged(tx, null);
    await recordAudit(tx, { action: "egress.ceiling.added", target: { domain: input.domain } });
    return { ok: true, entry: toEntry(must(row)), created: true };
  });
}

/** Puts a listed domain into or out of the ceiling; undefined when it isn't listed. */
export async function setCeilingMembership(
  db: KobeDb,
  domain: string,
  inCeiling: boolean,
): Promise<CeilingEntry | undefined> {
  return db.transaction(async (tx) => {
    const [before] = await tx
      .select()
      .from(egressDomains)
      .where(eq(egressDomains.domain, domain))
      .for("update");
    if (!before) return undefined;
    if (before.inCeiling === inCeiling) return toEntry(before);
    const [row] = await tx
      .update(egressDomains)
      .set({ inCeiling, updatedAt: new Date() })
      .where(eq(egressDomains.domain, domain))
      .returning();
    await notifyEgressChanged(tx, null);
    await recordAudit(tx, { action: "egress.ceiling.changed", target: { domain, inCeiling } });
    return toEntry(must(row));
  });
}

/** Puts every domain of a preset into or out of the ceiling (one audit event per change). */
export async function setPresetMembership(
  db: KobeDb,
  preset: EgressPreset,
  inCeiling: boolean,
): Promise<CeilingEntry[]> {
  return db.transaction(async (tx) => {
    const rows = await tx
      .update(egressDomains)
      .set({ inCeiling, updatedAt: new Date() })
      .where(
        sql`${egressDomains.preset} = ${preset} AND ${egressDomains.inCeiling} <> ${inCeiling}`,
      )
      .returning();
    if (rows.length > 0) await notifyEgressChanged(tx, null);
    for (const row of rows) {
      await recordAudit(tx, {
        action: "egress.ceiling.changed",
        target: { domain: row.domain, inCeiling },
      });
    }
    return rows.map(toEntry);
  });
}

export type DeleteResult = "deleted" | "not_found" | "preset";

/**
 * Deletes a custom domain; every team's enablement of it goes with it (FK cascade). Presets are
 * only taken out of the ceiling, never deleted.
 */
export async function deleteCeilingDomain(db: KobeDb, domain: string): Promise<DeleteResult> {
  return db.transaction(async (tx) => {
    const [row] = await tx
      .select()
      .from(egressDomains)
      .where(eq(egressDomains.domain, domain))
      .for("update");
    if (!row) return "not_found";
    if (row.preset) return "preset";
    await tx.delete(egressDomains).where(eq(egressDomains.domain, domain));
    await notifyEgressChanged(tx, null);
    await recordAudit(tx, { action: "egress.ceiling.removed", target: { domain } });
    return "deleted";
  });
}

function must<T>(value: T | undefined): T {
  if (value === undefined) throw new Error("egress ceiling write returned no row");
  return value;
}
