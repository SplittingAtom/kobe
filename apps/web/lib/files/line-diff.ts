/**
 * A small line diff for the proposal card (KOBE-592): `before` against `after`, as rows that are
 * kept, removed or added. Common head and tail lines are trimmed first; the middle uses a
 * longest-common-subsequence table, and past `LCS_CELLS_MAX` cells it falls back to "all removed,
 * then all added" so a huge rewrite never freezes the page.
 */
export type DiffRow = {
  readonly kind: "same" | "removed" | "added";
  readonly text: string;
};

const LCS_CELLS_MAX = 4_000_000;

/** Lines of a text; "" has none and a final newline does not make an empty last line. */
export function splitLines(text: string): readonly string[] {
  if (text === "") return [];
  const lines = text.split("\n");
  if (lines.at(-1) === "") lines.pop();
  return lines;
}

const rows = (kind: DiffRow["kind"], lines: readonly string[]): DiffRow[] =>
  lines.map((text) => ({ kind, text }));

export function lineDiff(before: string, after: string): readonly DiffRow[] {
  const a = splitLines(before);
  const b = splitLines(after);
  let head = 0;
  while (head < a.length && head < b.length && a[head] === b[head]) head++;
  let tail = 0;
  while (
    tail < a.length - head &&
    tail < b.length - head &&
    a[a.length - 1 - tail] === b[b.length - 1 - tail]
  ) {
    tail++;
  }
  const midA = a.slice(head, a.length - tail);
  const midB = b.slice(head, b.length - tail);
  return [
    ...rows("same", a.slice(0, head)),
    ...middle(midA, midB),
    ...rows("same", a.slice(a.length - tail)),
  ];
}

function middle(a: readonly string[], b: readonly string[]): DiffRow[] {
  if (a.length === 0 || b.length === 0) return [...rows("removed", a), ...rows("added", b)];
  if ((a.length + 1) * (b.length + 1) > LCS_CELLS_MAX) {
    return [...rows("removed", a), ...rows("added", b)];
  }
  const w = b.length + 1;
  const table = new Uint32Array((a.length + 1) * w);
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      table[i * w + j] =
        a[i] === b[j]
          ? (table[(i + 1) * w + j + 1] ?? 0) + 1
          : Math.max(table[(i + 1) * w + j] ?? 0, table[i * w + j + 1] ?? 0);
    }
  }
  const out: DiffRow[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      out.push({ kind: "same", text: a[i] ?? "" });
      i++;
      j++;
    } else if ((table[(i + 1) * w + j] ?? 0) >= (table[i * w + j + 1] ?? 0)) {
      out.push({ kind: "removed", text: a[i++] ?? "" });
    } else {
      out.push({ kind: "added", text: b[j++] ?? "" });
    }
  }
  return [...out, ...rows("removed", a.slice(i)), ...rows("added", b.slice(j))];
}
