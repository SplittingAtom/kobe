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

/** Quote-normalised (NFKC, invisible, quotes, dashes, whitespace), confusables folded, undefanged. */
export const plainText = (text: string): string => undefang(foldConfusables(normaliseQuote(text)));

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
