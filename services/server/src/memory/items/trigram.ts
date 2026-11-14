/**
 * Trigram similarity as pg_trgm's `similarity()` computes it (KOBE-382): each word (a run of
 * letters and digits, lowercased) is padded with two spaces before and one after, its trigrams
 * collected into a set, and the similarity of two texts is |A ∩ B| / |A ∪ B|. The selector scores
 * here rather than in Postgres: under FORCE RLS no trigram index helps, and pg_trgm rebuilds the
 * query's trigrams for every row (~25 µs a row at the scope limits). Trigrams are kept as numbers
 * (three UTF-16 code units), so text beyond the Basic Multilingual Plane scores slightly
 * differently from pg_trgm.
 */

const SPACE = 32;
const WORD_CHAR = /[\p{L}\p{N}]/u;

const isWordChar = (c: number): boolean =>
  (c >= 97 && c <= 122) ||
  (c >= 48 && c <= 57) ||
  (c > 127 && WORD_CHAR.test(String.fromCharCode(c)));

const key = (a: number, b: number, c: number) => a * 4294967296 + b * 65536 + c;

/** The trigram set of `text`. */
export function trigrams(text: string): Set<number> {
  const out = new Set<number>();
  const lower = text.toLowerCase();
  let a = SPACE;
  let b = SPACE;
  let inWord = false;
  for (let i = 0; i <= lower.length; i++) {
    const c = i < lower.length ? lower.charCodeAt(i) : SPACE;
    if (isWordChar(c)) {
      if (!inWord) {
        a = SPACE;
        b = SPACE;
        inWord = true;
      }
      out.add(key(a, b, c));
      a = b;
      b = c;
    } else if (inWord) {
      out.add(key(a, b, SPACE));
      inWord = false;
    }
  }
  return out;
}

/** pg_trgm `similarity(a, b)` with `b`'s trigrams given (0 when either has none). */
export function trigramSimilarity(a: string, b: ReadonlySet<number>): number {
  const set = trigrams(a);
  if (set.size === 0 || b.size === 0) return 0;
  let shared = 0;
  for (const t of set) if (b.has(t)) shared += 1;
  return shared / (set.size + b.size - shared);
}
