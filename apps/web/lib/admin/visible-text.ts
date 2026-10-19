/**
 * Invisible and direction-changing characters made visible (KOBE-334 review L4, "Trojan Source"):
 * in the review's diff a reviewer must see exactly what an agent will read, so each such
 * character is shown as a marker like ⟨U+202E⟩. The set follows the scanner's `INVISIBLE`
 * (@kobe/skill-scanner prose.ts): format and bidi controls, zero-width characters, the BOM, tag
 * characters and variation selectors (all, here: a diff isn't the place for emoji presentation).
 */
const INVISIBLE =
  // The combining marks in the class are matched one at a time, on purpose.
  // eslint-disable-next-line no-misleading-character-class
  /[\u00ad\u034f\u061c\u115f\u1160\u180e\u200b-\u200f\u202a-\u202e\u2028\u2029\u2060-\u2064\u2066-\u2069\u3164\ufe00-\ufe0f\ufeff\uffa0\u{e0000}-\u{e007f}\u{e0100}-\u{e01ef}]/gu;

export interface TextPart {
  readonly text: string;
  /** A hidden character, shown as its code point. */
  readonly hidden: boolean;
}

const codePoint = (ch: string) =>
  `⟨U+${(ch.codePointAt(0) ?? 0).toString(16).toUpperCase().padStart(4, "0")}⟩`;

/** `text` split into plain runs and markers for each hidden character. */
export function visibleParts(text: string): TextPart[] {
  const parts: TextPart[] = [];
  let last = 0;
  for (const m of text.matchAll(INVISIBLE)) {
    const at = m.index ?? 0;
    if (at > last) parts.push({ text: text.slice(last, at), hidden: false });
    parts.push({ text: codePoint(m[0]), hidden: true });
    last = at + m[0].length;
  }
  if (last < text.length) parts.push({ text: text.slice(last), hidden: false });
  return parts;
}
