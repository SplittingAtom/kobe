import { IGNORABLE } from "@kobe/skill-scanner";
import { normaliseQuote } from "../quote-normalise.js";

/**
 * Text views the memory check rules read (KOBE-379), so a rule can't be dodged by writing the
 * same words differently: Unicode compatibility forms, invisible characters, look-alike letters
 * from other scripts, letter spacing, leetspeak, defanged links and case.
 */

/**
 * Cyrillic and Greek letters that look like Latin ones (a small, fixed subset of Unicode's
 * confusables: the ones that render identically in common fonts), case kept.
 */
const CONFUSABLES: Readonly<Record<string, string>> = {
  "\u0430": "a",
  "\u0432": "b",
  "\u0441": "c",
  "\u0435": "e",
  "\u04bb": "h",
  "\u0456": "i",
  "\u0458": "j",
  "\u043a": "k",
  "\u043c": "m",
  "\u043d": "h",
  "\u043e": "o",
  "\u0440": "p",
  "\u0455": "s",
  "\u0442": "t",
  "\u0443": "y",
  "\u0445": "x",
  "\u0501": "d",
  "\u04cf": "l",
  "\u051b": "q",
  "\u051d": "w",
  "\u0410": "A",
  "\u0412": "B",
  "\u0421": "C",
  "\u0415": "E",
  "\u041d": "H",
  "\u0406": "I",
  "\u0408": "J",
  "\u041a": "K",
  "\u041c": "M",
  "\u041e": "O",
  "\u0420": "P",
  "\u0405": "S",
  "\u0422": "T",
  "\u0425": "X",
  "\u0423": "Y",
  "\u03b1": "a",
  "\u03b5": "e",
  "\u03b9": "i",
  "\u03ba": "k",
  "\u03bd": "v",
  "\u03bf": "o",
  "\u03c1": "p",
  "\u03c4": "t",
  "\u03c5": "u",
  "\u03c7": "x",
  "\u0391": "A",
  "\u0392": "B",
  "\u0395": "E",
  "\u0396": "Z",
  "\u0397": "H",
  "\u0399": "I",
  "\u039a": "K",
  "\u039c": "M",
  "\u039d": "N",
  "\u039f": "O",
  "\u03a1": "P",
  "\u03a4": "T",
  "\u03a5": "Y",
  "\u03a7": "X",
  "\u0131": "i",
  "\u0261": "g",
};
const CONFUSABLE = new RegExp(`[${Object.keys(CONFUSABLES).join("")}]`, "gu");

/** Replaces look-alike Cyrillic and Greek letters with their Latin twins (case kept). */
export const foldConfusables = (text: string): string =>
  text.replace(CONFUSABLE, (c) => CONFUSABLES[c] ?? c);

/** `hxxp://`, `example[.]com`, `http : //`: defanged links back to their plain form. */
export const undefang = (text: string): string =>
  text
    .replace(/\bhxxp(s?)\b/giu, "http$1")
    .replace(/\s*[[({]\s*(?:\.|dot)\s*[\])}]\s*/giu, ".")
    .replace(/\s*:\s*\/\s*\/\s*/gu, "://");

/**
 * Combining marks dropped after decomposing ("I\u0332gnore", "e\u0301" -> "Ignore", "e"): rules
 * read ASCII words and tokens, which never carry marks (KOBE-379 review M-2).
 */
const MARKS = /\p{M}/gu;
export const stripMarks = (text: string): string =>
  text.normalize("NFKD").replace(MARKS, "").normalize("NFC");

/**
 * Every default-ignorable code point (variation selectors after digits, joiners, Mongolian
 * selectors, tags...) with no emoji exception: emoji presentation never matters to a rule
 * (KOBE-379 review M-1, M-2).
 */
const IGNORABLE_ALL = new RegExp(IGNORABLE.source, "gu");

/**
 * Quote-normalised (NFKC, blanks as spaces, invisible characters, quotes, dashes, whitespace),
 * every default-ignorable code point and combining mark dropped, confusables folded, undefanged.
 */
export const plainText = (text: string): string =>
  undefang(foldConfusables(stripMarks(normaliseQuote(text).replace(IGNORABLE_ALL, ""))));

/** "i g n o r e", "i.g.n.o.r.e", "i-g-n-o-r-e": three or more single letters joined. */
const SPACED_LETTERS = /\b(?:\p{L}[ .\-_*]){2,}\p{L}\b/gu;
const despace = (text: string): string =>
  text.replace(SPACED_LETTERS, (run) => run.replace(/[ .\-_*]/gu, ""));

const LEET: Readonly<Record<string, string>> = {
  "0": "o",
  "1": "i",
  "3": "e",
  "4": "a",
  "5": "s",
  "7": "t",
  "@": "a",
  $: "s",
  "!": "i",
};
/** Leetspeak inside words only ("1gn0re"), so plain numbers stay numbers. */
const unleet = (text: string): string =>
  text.replace(/\b\p{L}*[013457@$!][\p{L}013457@$!]*\b/gu, (word) =>
    /\p{L}/u.test(word) ? word.replace(/[013457@$!]/gu, (c) => LEET[c] ?? c) : word,
  );

/**
 * Lower-cased views for the instruction rules: the plain text, with letter spacing joined, and
 * with leetspeak read as letters. A rule fires when it matches any view.
 */
export function lintViews(text: string): string[] {
  const plain = plainText(text).toLowerCase();
  return [...new Set([plain, despace(plain), unleet(despace(plain))])];
}

/** Whitespace between two chunks of 4+ token characters ("AKIA IOSF ODNN"). */
const SPLIT_TOKEN = /([\w+/=-]{4,})\s+(?=[\w+/=-]{4,})/gu;

/**
 * Case-kept views for the secret scan: as written, plain (see {@link plainText}), and plain with
 * the spaces inside split tokens removed ("AKIA IOSF ODNN 7EXA MPLE").
 */
export function secretViews(text: string): string[] {
  const plain = plainText(text);
  return [...new Set([text, plain, plain.replace(SPLIT_TOKEN, "$1")])];
}

/** Up to three spaces, hyphens or dots between two token characters. */
const SEPARATORS = /(?<=[A-Za-z0-9_])[\s.-]{1,3}(?=[A-Za-z0-9_])/gu;

/**
 * The plain text with every separator between token characters removed (KOBE-379 review M-4: a
 * token typed in short groups or split by hyphens). Read only by the prefix-anchored secret rules
 * (`matchSplitSecret`), never by the assignment rules, so joined prose can't become a password.
 */
export const collapsedView = (text: string): string => plainText(text).replace(SEPARATORS, "");

/** Encoded runs worth decoding: base64 / base64url (24+) and hex (32+), at most 4 KiB each. */
const BASE64_RUN = /[A-Za-z0-9+/_-]{24,4096}={0,2}/gu;
const HEX_RUN = /(?<![0-9A-Fa-f])[0-9A-Fa-f]{32,4096}(?![0-9A-Fa-f])/gu;
/** Runs decoded per text, at most. */
const MAX_DECODED = 8;
const PRINTABLE = /[\x20-\x7e\t\n\r]/gu;

/** Decoded text that reads as text (90% printable ASCII, 16+ characters), else null. */
function readable(bytes: Buffer): string | null {
  const text = bytes.toString("utf8");
  if (text.length < 16) return null;
  const printable = text.match(PRINTABLE)?.length ?? 0;
  return printable >= text.length * 0.9 ? text : null;
}

/**
 * Texts hidden in base64 or hex runs of `text` (KOBE-379 review M-5), decoded once (no nesting),
 * bounded in count and length, so the secret scan can read what they carry.
 */
export function decodedRuns(text: string): string[] {
  const plain = plainText(text);
  const out: string[] = [];
  const add = (decoded: string | null) => {
    if (decoded !== null && out.length < MAX_DECODED) out.push(decoded);
  };
  for (const m of plain.matchAll(HEX_RUN)) {
    if (out.length >= MAX_DECODED) break;
    const run = m[0].length % 2 === 0 ? m[0] : m[0].slice(0, -1);
    add(readable(Buffer.from(run, "hex")));
  }
  for (const m of plain.matchAll(BASE64_RUN)) {
    if (out.length >= MAX_DECODED) break;
    const run = m[0];
    const url = /[-_]/u.test(run);
    add(readable(Buffer.from(run, url ? "base64url" : "base64")));
  }
  return out;
}
