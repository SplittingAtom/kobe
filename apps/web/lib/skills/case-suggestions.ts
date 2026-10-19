import { isMap, isSeq, parseDocument, YAMLMap, YAMLSeq, type Document } from "yaml";

/**
 * Case suggestions for a draft's eval suite (KOBE-328, SK15): positive trigger cases from the
 * description's "Use when …" requests, and always negative ones (near misses and unrelated
 * asks), so trigger precision can be measured. Only a starting point the author edits; the same
 * shape the built-in skill-creator proposes in a chat.
 */
export interface SuggestedCase {
  readonly id: string;
  readonly prompt: string;
  readonly triggers: boolean;
}

/** Asks no skill should take: at least one is always suggested as a negative case. */
const UNRELATED = [
  "What is the capital of France?",
  "Write a two-line poem about the sea.",
  "How many days are there in a leap year?",
] as const;

const MAX_POSITIVE = 3;

function slug(text: string, fallback: string): string {
  const s = text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40)
    .replace(/-+$/g, "");
  return s || fallback;
}

/** The requests the description says the skill is for ("Use when asked for X, Y or Z."). */
function requestsOf(description: string): string[] {
  const m = /\buse (?:it |this )?(?:when(?:ever)?|for|if)\b([^.]*)/i.exec(description);
  if (!m?.[1]) return [];
  return m[1]
    .replace(/^\s*(?:the user |someone |asked (?:for|to) |they )+/i, "")
    .split(/,\s*|\s+or\s+|\s+and\s+/)
    .map((s) => s.replace(/^(?:asked (?:for|to)|wants? (?:to )?|needs? (?:to )?)\s*/i, "").trim())
    .filter((s) => s.length >= 3)
    .slice(0, MAX_POSITIVE);
}

/** Positive and negative trigger cases for a skill, ids unique against `taken`. */
export function suggestTriggerCases(input: {
  readonly name: string;
  readonly description: string;
  readonly taken?: readonly string[];
}): SuggestedCase[] {
  const used = new Set(input.taken ?? []);
  const unique = (base: string) => {
    let id = base;
    for (let n = 2; used.has(id); n += 1) id = `${base}-${n}`;
    used.add(id);
    return id;
  };
  const requests = requestsOf(input.description);
  const topic = input.name.replace(/-/g, " ");
  const positives = (requests.length > 0 ? requests : [topic]).map((r) => ({
    id: unique(slug(`uses-${r}`, "uses-skill")),
    prompt: requests.length > 0 ? `Please help: ${r}.` : `Help me with ${topic}.`,
    triggers: true,
  }));
  // A near miss names the topic without asking for the skill's work, then unrelated asks.
  const negatives = [
    {
      id: unique(slug(`near-miss-${input.name}`, "near-miss")),
      prompt: `What does "${topic}" mean?`,
    },
    ...UNRELATED.slice(0, 2).map((prompt, i) => ({
      id: unique(i === 0 ? "unrelated" : `unrelated-${i + 1}`),
      prompt,
    })),
  ].map((c) => ({ ...c, triggers: false }));
  return [...positives, ...negatives];
}

/** The ids of the cases already in `evals/cases.yaml` (none when it doesn't parse). */
export function caseIdsOf(text: string | undefined): string[] {
  if (!text) return [];
  const doc = parseDocument(text);
  const cases = isMap(doc.contents) ? doc.contents.get("cases") : undefined;
  if (!isSeq(cases)) return [];
  return cases.items.flatMap((item) => {
    const id = isMap(item) ? item.get("id") : undefined;
    return typeof id === "string" ? [id] : [];
  });
}

/**
 * `evals/cases.yaml` with the suggestions appended (comments and the rest kept), or a new file.
 * Null when the file holds something other than a mapping with a `cases` list.
 */
export function appendCases(
  text: string | undefined,
  cases: readonly SuggestedCase[],
): string | null {
  // Edited as a plain (not parsed-only) document, so new nodes can be added.
  const doc = parseDocument(
    text && text.trim() !== "" ? text : "cases: []\n",
  ) as unknown as Document;
  if (doc.errors.length > 0 || !isMap(doc.contents)) return null;
  let list = doc.contents.get("cases");
  if (list === undefined) {
    list = new YAMLSeq();
    doc.contents.set("cases", list);
  }
  if (!isSeq(list)) return null;
  list.flow = false;
  for (const c of cases) {
    const item = new YAMLMap();
    item.set("id", c.id);
    item.set("prompt", c.prompt);
    const expect = doc.createNode({ triggers: c.triggers }) as YAMLMap;
    expect.flow = true;
    item.set("expect", expect);
    list.add(item);
  }
  return doc.toString();
}
