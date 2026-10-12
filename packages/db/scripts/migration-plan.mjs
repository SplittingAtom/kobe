// Pure parts of db:rebase (rebase-migrations.mjs), kept apart so they can be unit tested.
//
// A hand-written migration (first line `-- kobe:hand-written`) changes the schema with SQL that
// drizzle-kit cannot regenerate, e.g. KOBE-256's in-place renames: drizzle-kit would prompt, or
// drop and re-create the tables (losing their rows). db:rebase keeps its SQL and its snapshot and
// only renumbers it: a new journal entry after the base's migrations, with the snapshot re-chained.

export const HAND_WRITTEN_MARKER = "-- kobe:hand-written";

export function isHandWritten(sql) {
  return sql.split("\n", 1)[0].trim() === HAND_WRITTEN_MARKER;
}

/** JSON with object keys sorted: drizzle-kit does not write snapshot keys in a stable order. */
export function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value === null || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map((k) => [k, canonical(value[k])]),
  );
}

/** Whether two snapshots describe the same schema (their id chain aside). */
export function sameSchema(a, b) {
  const strip = ({ id: _id, prevId: _prevId, ...rest }) => JSON.stringify(canonical(rest));
  return strip(a) === strip(b);
}

/**
 * The steps that re-create a branch's migrations on top of the base, in order. `migrations` are
 * the branch's own, oldest first: `{ name, sql, custom, handWritten, snapshot? }`.
 *
 * - generated (schema changes from drizzle-kit): one `generate` step for all of them, first;
 * - custom and hand-written: re-created in their original order with their saved SQL; a
 *   hand-written one also keeps its saved snapshot.
 *
 * A branch with both hand-written and generated migrations is refused: drizzle-kit would diff the
 * hand-written schema change as well (and prompt, or drop and re-create). Land them separately.
 */
export function regenerationSteps(migrations) {
  const handWritten = migrations.filter((m) => m.handWritten);
  const generated = migrations.filter((m) => !m.custom && !m.handWritten);
  if (handWritten.length > 0 && generated.length > 0) {
    throw new Error(
      `hand-written migration(s) ${handWritten.map((m) => m.name).join(", ")} cannot be ` +
        `regenerated together with generated ones (${generated.map((m) => m.name).join(", ")}): ` +
        "land them in separate PRs, or renumber by hand",
    );
  }
  const steps =
    generated.length > 0
      ? [{ kind: "generate", name: generated.map((m) => m.name).join("_") }]
      : [];
  for (const m of migrations.filter((x) => x.custom || x.handWritten)) {
    steps.push(
      m.handWritten
        ? { kind: "hand-written", name: m.name, sql: m.sql, snapshot: m.snapshot }
        : { kind: "custom", name: m.name, sql: m.sql },
    );
  }
  return steps;
}

/**
 * A kept snapshot needs the base's schema to be the one it was written against: if the base
 * changed the schema since the branch forked, the kept snapshot would lack those changes (and the
 * next `drizzle-kit generate` would emit them again). Returns an error message, or null.
 */
export function handWrittenBaseProblem(migrations, forkSnapshot, baseSnapshot) {
  if (!migrations.some((m) => m.handWritten)) return null;
  if (sameSchema(forkSnapshot, baseSnapshot)) return null;
  return (
    "the base changed the schema since this branch forked, so a hand-written migration's snapshot " +
    "cannot be kept: renumber it by hand (move its SQL and snapshot to the next index, fix the " +
    "journal idx and when, re-chain prevId) and re-derive its snapshot from the merged schema"
  );
}

/** A kept snapshot moved to its new place in the chain. */
export function rechainSnapshot(kept, { id, prevId }) {
  return { ...kept, id, prevId };
}
