/**
 * The "Admin change" approval card's before → after rows (KOBE-623, spec kobe-admin-mcp §5–§6),
 * read from the exact input being approved. A Kobe admin write names its target's before-state
 * in its input (`from_role` / `to_role`, `from` / `to`, `from_role` / `role`, …), so the card can
 * show the change side by side; the input itself is shown in full underneath, and the server's
 * summary line sits above. Pure: no names are guessed here (the server resolves them).
 */

export interface ChangeRow {
  readonly field: string;
  readonly before: string;
  readonly after: string;
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === "object" && !Array.isArray(v);

/** A value as short text: strings as they are, `null` as "none", anything else as JSON. */
export function shown(value: unknown): string {
  if (value === undefined || value === null) return "none";
  if (typeof value === "string") return value;
  return JSON.stringify(value) ?? String(value);
}

const label = (key: string) => key.replace(/_/g, " ");

/** The change's before → after rows, in input order; empty when the input names none. */
export function changeRows(input: unknown): ChangeRow[] {
  if (!isRecord(input)) return [];
  const rows: ChangeRow[] = [];
  const { from, to } = input;
  if (isRecord(to) || isRecord(from)) {
    const before = isRecord(from) ? from : {};
    const after = isRecord(to) ? to : {};
    for (const key of new Set([...Object.keys(after), ...Object.keys(before)])) {
      // `to: null` removes the whole thing (every field goes); otherwise only the fields set.
      if (isRecord(to) && !(key in after)) continue;
      rows.push({ field: label(key), before: shown(before[key]), after: shown(after[key]) });
    }
  } else if ("from" in input && "to" in input) {
    rows.push({ field: "value", before: shown(from), after: shown(to) });
  }
  for (const [key, value] of Object.entries(input)) {
    const m = /^(?:from|expected)_(.+)$/.exec(key);
    if (!m?.[1]) continue;
    const field = m[1];
    const afterKey = `to_${field}` in input ? `to_${field}` : field in input ? field : undefined;
    rows.push({
      field: label(field),
      before: shown(value),
      after: afterKey === undefined ? "(unchanged target)" : shown(input[afterKey]),
    });
  }
  return rows;
}
