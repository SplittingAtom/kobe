import { KOBE_SKILL_NAMES } from "@kobe/protocol";

/**
 * The Site's flat skill namespace (KOBE-332, SK24): catalog names are unique (the database's
 * `registry_skills_name_unique`), Kobe's built-in names are reserved for Kobe
 * (`registry_skills_kobe_names`), and near names are a typosquat hint for reviewers, never a block.
 */

const RESERVED: ReadonlySet<string> = new Set(KOBE_SKILL_NAMES);

export function isReservedName(name: string): boolean {
  return RESERVED.has(name);
}

/** Levenshtein distance (names are at most 64 characters). */
export function editDistance(a: string, b: string): number {
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i += 1) {
    const row = [i];
    for (let j = 1; j <= b.length; j += 1) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      row.push(Math.min((prev[j] ?? 0) + 1, (row[j - 1] ?? 0) + 1, (prev[j - 1] ?? 0) + cost));
    }
    prev = row;
  }
  return prev[b.length] ?? 0;
}

/** The name without separators: `sales-report`, `salesreport` and `sales_report` are one. */
const squash = (name: string) => name.replace(/[-_]/g, "");

/** Edits allowed before a name stops looking like another: 1 for short names, else 2. */
const allowance = (a: string, b: string) => (Math.max(a.length, b.length) <= 5 ? 1 : 2);

/** The names in `existing` that look like `name` (sorted), never `name` itself. */
export function similarNames(name: string, existing: readonly string[]): string[] {
  const mine = squash(name);
  return existing
    .filter(
      (other) =>
        other !== name &&
        (squash(other) === mine || editDistance(name, other) <= allowance(name, other)),
    )
    .sort();
}
