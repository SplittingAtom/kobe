import { sql, type KobeTx } from "@kobe/db";
import { lintViews } from "./text.js";

/**
 * Policy conflict (KOBE-379, SM23): a save that may contradict an active Policy item is blocked
 * with `memory_policy_conflict` (naming the Policy items) unless the writer saves anyway
 * (`overrides.policy_conflict`, audited as `memory.policy.override`).
 *
 * Candidates come from full-text search (the versions' `english` tsvector, Q11): a Policy item is
 * a candidate when the statement shares at least two of its lexemes (all of them for a one-word
 * Policy) and at least half. A candidate conflicts unless the statement only restates it: same
 * polarity (both or neither negated) and no lexeme the Policy lacks. Deterministic, so the import
 * preview and the commit agree.
 */

export interface PolicyEntry {
  readonly id: string;
  readonly version: number;
  readonly statement: string;
  readonly lexemes: readonly string[];
}

export interface PolicyConflict {
  readonly id: string;
  readonly version: number;
}

const NEGATION =
  /\b(?:no|not|never|none|nobody|nothing|neither|nor|don't|doesn't|didn't|isn't|aren't|won't|can't|cannot|mustn't|shouldn't|avoid\w*|forbid\w*|prohibit\w*|disallow\w*|ban|banned|without)\b/u;

/** Whether `text` is negated (any view: normalised, look-alikes folded, lower case). */
export const negated = (text: string): boolean => lintViews(text).some((v) => NEGATION.test(v));

/** The Policy items `statement` (with `lexemes`) may contradict. */
export function policyConflicts(
  statement: string,
  lexemes: readonly string[],
  policies: readonly PolicyEntry[],
): PolicyConflict[] {
  const mine = new Set(lexemes);
  const polarity = negated(statement);
  return policies
    .filter((p) => {
      const theirs = new Set(p.lexemes);
      if (theirs.size === 0) return false;
      const shared = [...theirs].filter((l) => mine.has(l)).length;
      const candidate = shared >= Math.min(2, theirs.size) && shared * 2 >= theirs.size;
      if (!candidate) return false;
      const restates = polarity === negated(p.statement) && [...mine].every((l) => theirs.has(l));
      return !restates;
    })
    .map((p) => ({ id: p.id, version: p.version }));
}

/**
 * Active Policy items (current versions, at most 25) and the statement's lexemes, read in the
 * save's transaction. `except`: the item being written (a Policy item is never compared with
 * itself).
 */
export async function readPolicyAndLexemes(
  tx: KobeTx,
  statement: string,
  except: readonly string[],
): Promise<{ readonly policies: PolicyEntry[]; readonly lexemes: string[] }> {
  const skip =
    except.length > 0
      ? sql`AND i.id NOT IN (${sql.join(
          except.map((id) => sql`${id}::uuid`),
          sql`, `,
        )})`
      : sql``;
  const { rows } = await tx.execute<{
    id: string;
    version: number;
    statement: string;
    lexemes: string[];
  }>(sql`
    SELECT i.id, i.current_version AS version, v.statement,
           tsvector_to_array(v.statement_tsv) AS lexemes
      FROM site_memory_items i
      JOIN site_memory_item_versions v ON v.item_id = i.id AND v.version = i.current_version
     WHERE i.policy AND i.status = 'active' ${skip}
     ORDER BY i.id`);
  if (rows.length === 0) return { policies: [], lexemes: [] };
  const mine = await tx.execute<{ lexemes: string[] }>(
    sql`SELECT tsvector_to_array(to_tsvector('english'::regconfig, ${lintViews(statement).join("\n")})) AS lexemes`,
  );
  return { policies: rows, lexemes: mine.rows[0]?.lexemes ?? [] };
}
