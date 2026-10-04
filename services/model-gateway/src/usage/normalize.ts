import type { RouteKind } from "../routes.js";

/**
 * Token counts as the ledger keeps them (KOBE-43): `input` is input **not** read from a prompt
 * cache, so input + cacheRead + cacheWrite is every prompt token once. Providers report these
 * differently; each `normalize*` maps one provider's usage object.
 */
export interface TokenCounts {
  readonly input: number;
  readonly output: number;
  readonly cacheRead: number;
  readonly cacheWrite: number;
}

/** Fields a usage report set; a stream may report them in several events. */
export type PartialCounts = { -readonly [K in keyof TokenCounts]?: number };

const num = (v: unknown): number | undefined =>
  typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : undefined;
const obj = (v: unknown): Record<string, unknown> | undefined =>
  v !== null && typeof v === "object" && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : undefined;

function defined(counts: {
  readonly [K in keyof TokenCounts]?: number | undefined;
}): PartialCounts | undefined {
  const out: PartialCounts = {};
  for (const [k, v] of Object.entries(counts) as [keyof TokenCounts, number | undefined][]) {
    if (v !== undefined) out[k] = v;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

/**
 * OpenAI-style usage: Chat Completions (`prompt_tokens` includes `cached_tokens`) or Responses
 * (`input_tokens` includes `input_tokens_details.cached_tokens`). Reasoning tokens are part of
 * the output counts in both.
 */
export function normalizeOpenAi(usage: unknown): PartialCounts | undefined {
  const u = obj(usage);
  if (!u) return undefined;
  const prompt = num(u.prompt_tokens) ?? num(u.input_tokens);
  const output = num(u.completion_tokens) ?? num(u.output_tokens);
  const details = obj(u.prompt_tokens_details) ?? obj(u.input_tokens_details);
  const cached = num(details?.cached_tokens) ?? 0;
  return defined({
    input: prompt === undefined ? undefined : Math.max(0, prompt - cached),
    cacheRead: prompt === undefined ? undefined : Math.min(cached, prompt),
    output,
  });
}

/** Anthropic Messages: `input_tokens` already excludes cache reads and cache writes. */
export function normalizeAnthropic(usage: unknown): PartialCounts | undefined {
  const u = obj(usage);
  if (!u) return undefined;
  return defined({
    input: num(u.input_tokens),
    output: num(u.output_tokens),
    cacheRead: num(u.cache_read_input_tokens),
    cacheWrite: num(u.cache_creation_input_tokens),
  });
}

/**
 * Gemini `usageMetadata`: `promptTokenCount` includes `cachedContentTokenCount`; tool-use prompt
 * tokens are input too; thinking tokens are billed as output.
 */
export function normalizeGemini(usage: unknown): PartialCounts | undefined {
  const u = obj(usage);
  if (!u) return undefined;
  const prompt = num(u.promptTokenCount);
  const cached = num(u.cachedContentTokenCount) ?? 0;
  const toolPrompt = num(u.toolUsePromptTokenCount) ?? 0;
  const candidates = num(u.candidatesTokenCount);
  const thoughts = num(u.thoughtsTokenCount);
  return defined({
    input: prompt === undefined ? undefined : Math.max(0, prompt - cached) + toolPrompt,
    cacheRead: prompt === undefined ? undefined : Math.min(cached, prompt),
    output:
      candidates === undefined && thoughts === undefined
        ? undefined
        : (candidates ?? 0) + (thoughts ?? 0),
  });
}

/**
 * The usage carried by one decoded JSON value of a response (a whole body, or one stream event),
 * or undefined. `final` marks a report that closes the response's accounting: Anthropic's
 * `message_start` carries only the input side, its `message_delta` the final output count.
 */
export function usageOf(
  kind: RouteKind,
  value: unknown,
): { readonly counts: PartialCounts; readonly final: boolean } | undefined {
  const v = obj(value);
  if (!v) return undefined;
  if (kind === "gemini") {
    const counts = normalizeGemini(v.usageMetadata);
    return counts ? { counts, final: counts.output !== undefined } : undefined;
  }
  if (kind === "anthropic") {
    if (v.type === "message_start") {
      const counts = normalizeAnthropic(obj(v.message)?.usage);
      return counts ? { counts, final: false } : undefined;
    }
    const counts = normalizeAnthropic(v.usage);
    return counts ? { counts, final: counts.output !== undefined } : undefined;
  }
  // OpenAI Responses streams nest the usage in the closing `response.*` event.
  const nested = obj(v.response);
  const counts = normalizeOpenAi(v.usage) ?? normalizeOpenAi(nested?.usage);
  return counts ? { counts, final: counts.output !== undefined } : undefined;
}
