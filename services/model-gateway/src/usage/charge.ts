/**
 * What a call is charged when the provider's usage report is missing (KOBE-43 review): a stream
 * cut short (the sandbox hung up, an upstream reset), a 5xx or a call that never answered after
 * Bifrost received it, or a response without a report. Hidden reasoning tokens and output still
 * buffered upstream are never seen, so the output side is at least what the request allowed:
 * `min(requested max, MAX_CHARGED_OUTPUT_TOKENS)`, or {@link DEFAULT_CHARGED_OUTPUT_TOKENS} when
 * the request set no cap. Generous on purpose: hiding usage never makes a call cheaper.
 */
export const DEFAULT_CHARGED_OUTPUT_TOKENS = 8_192;
export const MAX_CHARGED_OUTPUT_TOKENS = 65_536;

/**
 * The output a call is charged at least when its usage is unknown: per answer the requested cap
 * (unbounded when unreadable) up to the ceiling, times the answers asked for (`n`,
 * `candidateCount`). Count-only endpoints (`count_tokens`, `countTokens`) generate nothing: 0.
 *
 * Residual risk (documented): the ceiling is one install-wide constant, not per model; hidden
 * reasoning beyond 65,536 tokens on a call whose usage report is lost is not charged.
 */
export function chargedOutput(
  requested: number | undefined,
  choices = 1,
  countOnly = false,
): number {
  if (countOnly) return 0;
  return Math.min(requested ?? DEFAULT_CHARGED_OUTPUT_TOKENS, MAX_CHARGED_OUTPUT_TOKENS) * choices;
}
