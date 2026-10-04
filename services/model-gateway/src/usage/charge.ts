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

export function chargedOutput(requested: number | undefined): number {
  return Math.min(requested ?? DEFAULT_CHARGED_OUTPUT_TOKENS, MAX_CHARGED_OUTPUT_TOKENS);
}
