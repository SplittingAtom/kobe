import { INVISIBLE } from "@kobe/skill-scanner";

/**
 * The shared quote normaliser (KOBE-379, SM9/SM29). Two texts that read the same to a person
 * compare equal after it: Unicode compatibility forms (NFKC: full-width letters, ligatures, `\u2026`),
 * curly and angled quotes, every dash and minus, invisible characters (zero-width, bidi controls,
 * tag characters; the skill scanner's set) and runs of whitespace. Case is kept.
 *
 * Used by the memory save checks (`memory/checks.ts`) before their rules run, and by SMB5
 * (KOBE-393) to verify that an evidence quote really appears in the conversation:
 * {@link quoteFoundIn}.
 */

const INVISIBLE_ALL = new RegExp(INVISIBLE.source, "gu");
/** Double primes NFKC would split into two single primes: fold them first. */
const DOUBLE_PRIMES = /[\u2033\u2036]/gu;
const DOUBLE_QUOTES = /[\u201c\u201d\u201e\u201f\u00ab\u00bb\u301d\u301e\u301f\uff02]/gu;
const SINGLE_QUOTES = /[\u2018\u2019\u201a\u201b\u2032\u2035\u2039\u203a\u02bb\u02bc\u00b4`]/gu;
const DASHES = /[\u2010-\u2015\u2212\u2e3a\u2e3b\ufe58\ufe63\uff0d]/gu;
const WHITESPACE = /\s+/gu;

/** NFKC, invisible characters dropped, quotes and dashes folded, whitespace collapsed, trimmed. */
export function normaliseQuote(text: string): string {
  // Quotes are folded before NFKC too: it turns `\u00b4` into a space and a combining accent.
  return text
    .replace(DOUBLE_PRIMES, '"')
    .replace(SINGLE_QUOTES, "'")
    .normalize("NFKC")
    .replace(INVISIBLE_ALL, "")
    .replace(DOUBLE_QUOTES, '"')
    .replace(SINGLE_QUOTES, "'")
    .replace(DASHES, "-")
    .replace(WHITESPACE, " ")
    .trim();
}

/**
 * Whether `quote` appears in `source` once both are normalised. An empty (or whitespace-only)
 * quote is never found. `caseInsensitive` also folds case (default: exact case).
 */
export function quoteFoundIn(
  quote: string,
  source: string,
  options: { readonly caseInsensitive?: boolean } = {},
): boolean {
  const fold = (s: string) =>
    options.caseInsensitive ? normaliseQuote(s).toLowerCase() : normaliseQuote(s);
  const q = fold(quote);
  return q.length > 0 && fold(source).includes(q);
}
