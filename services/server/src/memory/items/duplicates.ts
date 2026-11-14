import { sql, type KobeTx } from "@kobe/db";
import type { SemanticMemoryIssue } from "@kobe/protocol";
import type { Location } from "./location.js";

/**
 * Near-duplicate check (KOBE-378, SM10): every save path that writes a statement (editor create,
 * edit and Undo here; import, candidate save and approval in later tickets, through
 * {@link findNearDuplicates}) compares it by trigram similarity (`pg_trgm`) with the current
 * statements of active items in the same scope. A match is a warning, `near_duplicate`, that
 * names the items; "Save anyway" is `overrides.lint` (audited as `memory.lint.override`).
 */

/** Trigram similarity at which two statements count as near-duplicates. */
export const NEAR_DUPLICATE_SIMILARITY = 0.6;
/** Most matches named in a warning (the contract's cap). */
const MAX_MATCHES = 5;

export interface NearDuplicate {
  readonly id: string;
  readonly version: number;
  readonly similarity: number;
}

export const NEAR_DUPLICATE_WARNING: SemanticMemoryIssue = {
  code: "near_duplicate",
  message: "A similar memory already exists in this scope.",
};

/**
 * Active items of `loc` similar to `statement`, most similar first (`except`: the item itself and
 * any item the save replaces).
 */
export async function findNearDuplicates(
  tx: KobeTx,
  loc: Location,
  statement: string,
  except: readonly string[] = [],
): Promise<NearDuplicate[]> {
  const skip =
    except.length > 0
      ? sql`AND i.id NOT IN (${sql.join(
          except.map((id) => sql`${id}::uuid`),
          sql`, `,
        )})`
      : sql``;
  const { rows } = await tx.execute<{ id: string; version: number; similarity: number }>(sql`
    SELECT i.id, i.current_version AS version, round(similarity(v.statement, ${statement})::numeric, 3)::float8 AS similarity
      FROM ${loc.items} i JOIN ${loc.versions} v ON ${loc.versionOf} AND v.version = i.current_version
     WHERE ${loc.where} AND i.status = 'active'
       ${skip}
       AND similarity(v.statement, ${statement}) >= ${NEAR_DUPLICATE_SIMILARITY}
     ORDER BY similarity DESC, i.id
     LIMIT ${MAX_MATCHES}`);
  return rows.map((r) => ({ id: r.id, version: r.version, similarity: Number(r.similarity) }));
}

/**
 * Batch form for imports (review-385 M-2): every statement's near-duplicates in one query
 * (`unnest … WITH ORDINALITY` with a lateral match), keyed by statement.
 */
export async function findNearDuplicatesMany(
  tx: KobeTx,
  loc: Location,
  statements: readonly string[],
): Promise<Map<string, NearDuplicate[]>> {
  const unique = [...new Set(statements)];
  const out = new Map<string, NearDuplicate[]>(unique.map((s) => [s, []]));
  if (unique.length === 0) return out;
  const { rows } = await tx.execute<{
    n: number;
    id: string;
    version: number;
    similarity: number;
  }>(sql`
    SELECT t.n::int AS n, m.id, m.version, m.similarity
      FROM unnest(ARRAY[${sql.join(
        unique.map((s) => sql`${s}`),
        sql`, `,
      )}]::text[]) WITH ORDINALITY AS t(statement, n)
      CROSS JOIN LATERAL (
        SELECT i.id, i.current_version AS version,
               round(similarity(v.statement, t.statement)::numeric, 3)::float8 AS similarity
          FROM ${loc.items} i JOIN ${loc.versions} v ON ${loc.versionOf} AND v.version = i.current_version
         WHERE ${loc.where} AND i.status = 'active'
           AND similarity(v.statement, t.statement) >= ${NEAR_DUPLICATE_SIMILARITY}
         ORDER BY similarity DESC, i.id
         LIMIT ${MAX_MATCHES}) m
     ORDER BY t.n, m.similarity DESC, m.id`);
  for (const r of rows)
    out
      .get(unique[r.n - 1] as string)
      ?.push({ id: r.id, version: r.version, similarity: Number(r.similarity) });
  return out;
}
