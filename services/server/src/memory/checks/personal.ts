import type { SemanticMemoryWarningCode } from "@kobe/protocol";
import { plainText } from "./text.js";

/**
 * Personal-data warning (KOBE-379, SM18) for Workspace and Site items, which many people read:
 * email addresses, phone numbers, and a person's name near a sensitive word (health, pay,
 * discipline, family, identity documents). Heuristics, so a warning, never a block.
 */

type PersonalCode = Extract<SemanticMemoryWarningCode, `personal_${string}`>;

/** Also catches `name [at] example [dot] com` and `name (at) example.com`. */
const EMAIL =
  /[\p{L}\p{N}._%+-]+\s*(?:@|[[({]\s*at\s*[\])}])\s*[\p{L}\p{N}-]+(?:\s*(?:\.|[[({]\s*dot\s*[\])}])\s*[\p{L}\p{N}-]+)*\s*(?:\.|[[({]\s*dot\s*[\])}])\s*\p{L}{2,}/iu;

/** A run of digits with phone separators; 9 to 15 digits (E.164), dates and times excluded. */
const PHONE_RUN = /(?:\+|\b)\d[\d\s().-]{7,22}\d\b/gu;
const TOKEN_CHAR = /[\p{L}\p{N}_-]/u;
const DATE_LIKE = /^\d{4}-\d{2}-\d{2}|^\d{1,2}[./-]\d{1,2}[./-]\d{2,4}$/u;

function hasPhone(text: string): boolean {
  for (const m of text.matchAll(PHONE_RUN)) {
    // Part of a longer token (an id, a hash, a UUID): not a phone number.
    const before = text[m.index - 1] ?? " ";
    const after = text[m.index + m[0].length] ?? " ";
    if (TOKEN_CHAR.test(before) || TOKEN_CHAR.test(after)) continue;
    const run = m[0].trim();
    const digits = run.replace(/\D/gu, "").length;
    if (digits >= 9 && digits <= 15 && !DATE_LIKE.test(run)) return true;
  }
  return false;
}

const SENSITIVE = new RegExp(
  String.raw`\b(?:salary|salaries|pay ?(?:rise|cut|grade)|compensation|bonus|diagnos\w*|medical|medication|mental health|health (?:condition|issue|problem)s?|illness|sick(?:ness)? leave|therapy|pregnan\w*|maternity|disabilit\w*|divorc\w*|arrested|criminal record|convicted|religio\w*|sexual\w*|disciplinary|warning letter|fired|dismissed from|made redundant|redundancy (?:pay|notice)|performance (?:review|improvement plan)|home address|lives at|ssn|social security|passport|national id|date of birth|born on|immigration|visa status|personal debt|bankrupt\w*)\b`,
  "giu",
);
/**
 * A name: an honorific and a word, two capitalised words, a capitalised word mid-sentence, or one
 * opening a sentence as its subject ("Bob's", "Bob is").
 */
const NAME =
  /\b(?:Mr|Mrs|Ms|Miss|Dr|Prof)\.?\s+\p{Lu}[\p{Ll}'-]+|\b\p{Lu}[\p{Ll}'-]+\s+\p{Lu}[\p{Ll}'-]+|(?<=[\p{Ll},]\s+)\p{Lu}[\p{Ll}'-]+|(?<=^|[.!?]\s+)\p{Lu}[\p{Ll}-]+(?='s\b|\s+(?:is|was|has|had|got|gets|will|needs?|takes?|took)\b)/gu;
/** Characters between a name and a sensitive word that still count as "near". */
const NEAR = 80;

function spans(re: RegExp, text: string): [number, number][] {
  return [...text.matchAll(re)].map((m) => [m.index, m.index + m[0].length]);
}

function nameNearSensitive(text: string): boolean {
  const names = spans(NAME, text);
  if (names.length === 0) return false;
  return spans(SENSITIVE, text).some(([s, e]) =>
    names.some(([ns, ne]) => (ns >= e ? ns - e : s - ne) <= NEAR),
  );
}

/** The personal-data codes `text` triggers (each at most once). */
export function findPersonalData(text: string): PersonalCode[] {
  const plain = plainText(text);
  const codes: PersonalCode[] = [];
  if (EMAIL.test(plain)) codes.push("personal_email");
  if (hasPhone(plain)) codes.push("personal_phone");
  if (nameNearSensitive(plain)) codes.push("personal_sensitive");
  return codes;
}
