/**
 * A line diff for the template review (KOBE-434): the source is shown as text, never rendered.
 * Common head and tail lines are trimmed; the middle is aligned by longest common subsequence
 * when it is small enough, otherwise shown as the removed block then the added block.
 */
export interface DiffLine {
  readonly kind: "same" | "removed" | "added";
  readonly text: string;
}

/** Largest middle (lines × lines) aligned by LCS; beyond it the blocks are shown whole. */
const MAX_CELLS = 4_000_000;

function lcsMiddle(a: readonly string[], b: readonly string[]): DiffLine[] {
  const n = a.length;
  const m = b.length;
  // lengths[i][j] = LCS of a[i..] and b[j..], in one flat array.
  const lengths = new Uint32Array((n + 1) * (m + 1));
  const at = (i: number, j: number) => i * (m + 1) + j;
  for (let i = n - 1; i >= 0; i -= 1) {
    for (let j = m - 1; j >= 0; j -= 1) {
      lengths[at(i, j)] =
        a[i] === b[j]
          ? (lengths[at(i + 1, j + 1)] ?? 0) + 1
          : Math.max(lengths[at(i + 1, j)] ?? 0, lengths[at(i, j + 1)] ?? 0);
    }
  }
  const out: DiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      out.push({ kind: "same", text: a[i] ?? "" });
      i += 1;
      j += 1;
    } else if ((lengths[at(i + 1, j)] ?? 0) >= (lengths[at(i, j + 1)] ?? 0)) {
      out.push({ kind: "removed", text: a[i] ?? "" });
      i += 1;
    } else {
      out.push({ kind: "added", text: b[j] ?? "" });
      j += 1;
    }
  }
  for (; i < n; i += 1) out.push({ kind: "removed", text: a[i] ?? "" });
  for (; j < m; j += 1) out.push({ kind: "added", text: b[j] ?? "" });
  return out;
}

export function lineDiff(before: string, after: string): DiffLine[] {
  const a = before.split(/\r?\n/);
  const b = after.split(/\r?\n/);
  let head = 0;
  while (head < a.length && head < b.length && a[head] === b[head]) head += 1;
  let tail = 0;
  while (
    tail < a.length - head &&
    tail < b.length - head &&
    a[a.length - 1 - tail] === b[b.length - 1 - tail]
  ) {
    tail += 1;
  }
  const same = (lines: readonly string[]): DiffLine[] =>
    lines.map((text) => ({ kind: "same", text }));
  const midA = a.slice(head, a.length - tail);
  const midB = b.slice(head, b.length - tail);
  const middle =
    midA.length * midB.length <= MAX_CELLS
      ? lcsMiddle(midA, midB)
      : [
          ...midA.map((text): DiffLine => ({ kind: "removed", text })),
          ...midB.map((text): DiffLine => ({ kind: "added", text })),
        ];
  return [...same(a.slice(0, head)), ...middle, ...same(a.slice(a.length - tail))];
}
