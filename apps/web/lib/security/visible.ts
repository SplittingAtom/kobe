/**
 * Text shown exactly as stored. Characters that make shown text differ from the bytes (controls,
 * format characters such as bidi overrides/isolates U+202A–202E, U+2066–2069, zero-width
 * U+200B–200F, U+FEFF, line and paragraph separators, surrogates, private-use and unusual spaces)
 * become visible `\uXXXX` escapes, so a reviewer sees what will be stored (KOBE-157/158).
 */
const INVISIBLE = /[\p{Cc}\p{Cf}\p{Cs}\p{Co}\p{Zl}\p{Zp}\u00a0\u2000-\u200a\u202f\u205f\u3000]/gu;

/** `text` with every invisible or reordering character as a visible `\uXXXX` escape. */
export function visible(text: string, keep: RegExp = /\n/): string {
  return text.replace(INVISIBLE, (ch) =>
    keep.test(ch) ? ch : `\\u${(ch.codePointAt(0) ?? 0).toString(16).padStart(4, "0")}`,
  );
}
