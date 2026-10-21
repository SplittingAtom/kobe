import {
  CONTEXT_LABEL_MAX_CHARS,
  CONTEXT_MAX_SECTIONS,
  CONTEXT_SECTION_MAX_CHARS,
  THREAD_CONTEXT_PLAINTEXT_MAX_BYTES,
  contextTruncationMarker,
  type ContextSection,
  type ThreadContextResult as Result,
  type ContextSource,
  type ThreadContextResult,
} from "@kobe/protocol";
import type { RawSection } from "./system-prompt.js";

/**
 * Token counts and size caps of the context viewer's answer (KOBE-470, CV5, CV6).
 *
 * Tokens: no tokenizer runs in the sandbox, so each section is estimated the way Pi estimates
 * (`compaction.js` `estimateTokens`: characters / 4, an image 1200), then, when the call reported
 * its prompt tokens, scaled so the sections add up to exactly that number (largest remainder), the
 * number the context gauge shows. The scaled split is still an estimate per section.
 *
 * Size: each section's text is cut at {@link CONTEXT_SECTION_MAX_CHARS}, then lower until all of
 * them fit `maxBytes` (UTF-8) and the whole frame fits the wire; a cut text ends with the marker.
 * Past {@link CONTEXT_MAX_SECTIONS} the middle of the conversation is left out (one `other`
 * section says how many), so the prompt and the newest messages stay.
 */
export const CHARS_PER_TOKEN = 4;
export const IMAGE_TOKENS = 1200;
const MIN_CUT = 256;

export interface ContextFacts {
  readonly source: ContextSource;
  /** False for an answer rebuilt from the session (CV4), with what it may lack. */
  readonly exact: boolean;
  readonly missing: Result["missing"];
  readonly capturedAt: string | null;
  readonly model: string | null;
  readonly contextWindow: number | null;
  /** The call's reported prompt tokens (input + cache read + cache write); null: none reported. */
  readonly promptTokens: number | null;
}

const estimate = (s: RawSection): number =>
  Math.ceil(s.text.length / CHARS_PER_TOKEN) + (s.images ?? 0) * IMAGE_TOKENS;

/** Estimates scaled to `total` with the largest-remainder method (sum is exactly `total`). */
export function scaleTokens(estimates: readonly number[], total: number): number[] {
  const sum = estimates.reduce((a, b) => a + b, 0);
  if (sum === 0) {
    return estimates.map((_, i) => (i === estimates.length - 1 ? total : 0));
  }
  const exact = estimates.map((e) => (e * total) / sum);
  const floors = exact.map(Math.floor);
  let left = total - floors.reduce((a, b) => a + b, 0);
  const order = exact
    .map((x, i) => ({ i, rest: x - Math.floor(x) }))
    .sort((a, b) => b.rest - a.rest || a.i - b.i);
  for (const { i } of order) {
    if (left <= 0) break;
    floors[i] = (floors[i] ?? 0) + 1;
    left -= 1;
  }
  return floors;
}

/** `text` cut to at most `max` UTF-16 units, never inside a surrogate pair. */
function cut(text: string, max: number): string {
  if (text.length <= max) return text;
  let end = max;
  const code = text.charCodeAt(end - 1);
  if (code >= 0xd800 && code <= 0xdbff) end -= 1;
  return text.slice(0, end);
}

function shown(s: RawSection, max: number): { text: string; truncated: boolean } {
  if (s.text.length <= max) return { text: s.text, truncated: false };
  const head = cut(s.text, max);
  return { text: head + contextTruncationMarker(s.text.length - head.length), truncated: true };
}

const oneLine = (label: string): string =>
  cut(label.replace(/[\r\n\t]+/g, " "), CONTEXT_LABEL_MAX_CHARS);

/** Leave out the middle past the count cap; the placeholder carries their tokens. */
interface Item {
  readonly raw: RawSection;
  readonly tokens: number;
  readonly placeholder?: true;
}

function capCount(sections: readonly Item[]): { kept: Item[]; omitted: number } {
  if (sections.length <= CONTEXT_MAX_SECTIONS) return { kept: [...sections], omitted: 0 };
  const head = Math.floor((CONTEXT_MAX_SECTIONS - 1) / 4);
  const tail = CONTEXT_MAX_SECTIONS - 1 - head;
  const middle = sections.slice(head, sections.length - tail);
  const placeholder = {
    raw: {
      kind: "other" as const,
      label: `${middle.length} sections not shown`,
      text: "",
    },
    tokens: middle.reduce((a, s) => a + s.tokens, 0),
    placeholder: true as const,
  };
  return {
    kept: [...sections.slice(0, head), placeholder, ...sections.slice(sections.length - tail)],
    omitted: middle.length,
  };
}

function render(kept: readonly Item[], max: number): ContextSection[] {
  return kept.map(({ raw, tokens, placeholder }) => {
    const view = shown(raw, max);
    return {
      kind: raw.kind,
      label: oneLine(raw.label),
      text: view.text,
      tokens,
      chars: raw.text.length,
      truncated: view.truncated || placeholder === true,
    };
  });
}

const textBytes = (sections: readonly ContextSection[]): number =>
  sections.reduce((a, s) => a + Buffer.byteLength(s.text), 0);

export function finalizeContext(
  raw: readonly RawSection[],
  facts: ContextFacts,
  maxBytes: number,
): ThreadContextResult {
  const estimates = raw.map(estimate);
  const usage = facts.promptTokens !== null && facts.promptTokens > 0 ? facts.promptTokens : null;
  const tokens = usage === null ? estimates : scaleTokens(estimates, usage);
  const { kept, omitted } = capCount(raw.map((r, i) => ({ raw: r, tokens: tokens[i] ?? 0 })));
  const base = {
    source: facts.source,
    exact: facts.exact,
    missing: [...facts.missing],
    captured_at: facts.capturedAt,
    model: facts.model,
    context_window: facts.contextWindow,
    total_tokens: tokens.reduce((a, b) => a + b, 0),
    tokens_basis: usage === null ? ("estimate" as const) : ("usage" as const),
    omitted_sections: omitted,
  };
  let max = CONTEXT_SECTION_MAX_CHARS;
  for (;;) {
    const sections = render(kept, max);
    const result: ThreadContextResult = {
      ...base,
      sections,
      truncated: omitted > 0 || sections.some((s) => s.truncated),
    };
    const fits =
      textBytes(sections) <= maxBytes &&
      Buffer.byteLength(JSON.stringify(result)) <= THREAD_CONTEXT_PLAINTEXT_MAX_BYTES;
    if (fits || max <= MIN_CUT) return fits ? result : { ...result, sections: [], truncated: true };
    max = Math.max(MIN_CUT, Math.floor(max / 2));
  }
}
