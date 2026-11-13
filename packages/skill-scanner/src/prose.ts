/**
 * Prose rules (KOBE-312, spec SK32), on every text file: instructions written to steer the model
 * against its user or its policy, invisible or bidi characters that hide text from a reviewer,
 * and "prerequisite" steps that install or fetch something before the skill is used. Caution:
 * a reviewer reads and acknowledges each one. All patterns are linear (bounded gaps).
 */
export interface ProseRule {
  readonly id: string;
  readonly pattern: RegExp;
}

export const PROSE_RULES: readonly ProseRule[] = [
  {
    id: "prompt-injection",
    pattern:
      /\b(?:ignore|disregard|forget|override)\s+(?:all\s+|any\s+)?(?:of\s+)?(?:the\s+|your\s+)?(?:previous|prior|above|earlier|system|original)\s+(?:instructions|prompts?|rules|guidelines|messages)\b|\bdisregard\s+the\s+system\s+prompt\b|\byou\s+are\s+now\s+(?:in\s+)?(?:developer|god|jailbreak|dan|unrestricted)\s*mode\b/i,
  },
  {
    id: "conceal-from-user",
    pattern:
      /\b(?:do\s+not|don't|never)\s+(?:tell|inform|notify|show|reveal\s+to|mention\s+to)\s+the\s+user\b|\bwithout\s+(?:telling|informing|asking)\s+the\s+user\b|\bkeep\s+this\s+(?:secret|hidden)\s+from\s+the\s+user\b/i,
  },
  {
    id: "exfiltration-request",
    pattern:
      /\b(?:send|post|upload|exfiltrate|forward|transmit)\s+(?:all\s+|any\s+)?(?:the\s+)?(?:\w+\s+){0,3}(?:credentials|secrets|api\s+keys?|tokens|passwords|private\s+keys?|env(?:ironment)?\s+variables)\b[^\n]{0,80}\b(?:to|at)\s+(?:https?:\/\/|[\w-]+\.[a-z]{2,})/i,
  },
  {
    id: "prerequisite-install",
    pattern:
      /\b(?:prerequisites?|before\s+(?:using|running|you\s+use)\s+this\s+skill|first,?\s+(?:run|install|execute))\b[^\n]{0,120}?\b(?:curl|wget|pip3?\s+install|npm\s+(?:install|i)\b|brew\s+install|apt(?:-get)?\s+install|bash\s+-c|\|\s*(?:ba)?sh\b|iex\b|powershell)/i,
  },
];

/**
 * Invisible formatting characters that hide text from a reviewer: zero-width and bidi controls,
 * the Unicode Tag block (U+E0000 to E007F, "ASCII smuggling"), variation selectors (also the
 * Mongolian free variation selectors U+180B to 180F), Hangul fillers, interlinear annotation
 * marks (U+FFF9 to FFFB), musical formatting controls (U+1D173 to 1D17A), the combining grapheme
 * joiner and line/paragraph separators. Emoji keep working: one variation selector right after a
 * pictograph (or before a keycap mark), and a zero-width joiner between pictographs, are
 * presentation, not smuggling (a run of selectors, or one after a digit, is still flagged:
 * KOBE-379 review M-1).
 */
export const INVISIBLE =
  // The combining marks in the classes are matched one at a time, on purpose.
  // eslint-disable-next-line no-misleading-character-class
  /[\u00ad\u034f\u061c\u115f\u1160\u180b-\u180f\u200b\u200c\u200e\u200f\u202a-\u202e\u2028\u2029\u2060-\u2064\u2066-\u2069\u3164\ufeff\uffa0\ufff9-\ufffb\u{1d173}-\u{1d17a}\u{e0000}-\u{e007f}\u{e0100}-\u{e01ef}]|(?<!\p{Extended_Pictographic})[\ufe00-\ufe0f](?!\u20e3)|(?<![\p{Extended_Pictographic}\ufe0f\u{1f3fb}-\u{1f3ff}])\u200d|\u200d(?!\p{Extended_Pictographic})/u;

/**
 * Every default-ignorable code point (Unicode's own set: format controls, variation selectors,
 * fillers, tags) plus the interlinear annotation marks, with no emoji exception: what a text view
 * for matching drops unconditionally (KOBE-379 memory checks; emoji presentation never matters to
 * a rule). Hangul and Braille blanks render as a space: map them first (see the memory checks'
 * quote normaliser).
 */
export const IGNORABLE = /[\p{Default_Ignorable_Code_Point}\ufff9-\ufffb]/u;
