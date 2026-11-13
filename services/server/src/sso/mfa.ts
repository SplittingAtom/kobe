import type { MfaRule } from "./schemas.js";

/** The MFA evidence of a validated ID token (claims.ts). */
export interface MfaProof {
  readonly amr: readonly string[];
  readonly acr: string | null;
  /** Entra authentication context class references (`acrs`); empty for other providers. */
  readonly acrs: readonly string[];
}

/**
 * Spec §8 (SSO3): the claim value that proved multi-factor authentication, as `amr:<v>`,
 * `acr:<v>` or `acrs:<v>`; null when none did. Any `amr` value (RFC 8176) of the provider's
 * `mfa_rule`, or the `acr` exactly, or (Entra only) an `acrs` authentication context. Exact,
 * case-sensitive matches only. Rule values are short printable ASCII (schemas.ts), so the result
 * is safe to audit (review L3).
 */
export function mfaEvidence(kind: "entra" | "oidc", rule: MfaRule, proof: MfaProof): string | null {
  const amr = proof.amr.find((v) => rule.amr_any.includes(v));
  if (amr !== undefined) return `amr:${amr}`;
  if (proof.acr !== null && rule.acr_any.includes(proof.acr)) return `acr:${proof.acr}`;
  const acrs = kind === "entra" ? proof.acrs.find((v) => rule.acrs_any.includes(v)) : undefined;
  return acrs === undefined ? null : `acrs:${acrs}`;
}

/** Whether the sign-in proved multi-factor authentication under the rule (`mfaEvidence`). */
export function mfaProven(kind: "entra" | "oidc", rule: MfaRule, proof: MfaProof): boolean {
  return mfaEvidence(kind, rule, proof) !== null;
}

/**
 * The OIDC `claims` request parameter that asks Entra for the rule's authentication contexts as an
 * essential `acrs` claim (§8), e.g. `{"id_token":{"acrs":{"essential":true,"value":"c1"}}}`, so
 * Conditional Access enforces the context's MFA before issuing the token. Undefined when there is
 * nothing to ask for (generic providers, or no contexts listed).
 */
export function acrsClaimsParameter(kind: "entra" | "oidc", rule: MfaRule): string | undefined {
  if (kind !== "entra" || rule.acrs_any.length === 0) return undefined;
  const [only] = rule.acrs_any;
  const acrs =
    rule.acrs_any.length === 1
      ? { essential: true, value: only }
      : { essential: true, values: [...rule.acrs_any] };
  return JSON.stringify({ id_token: { acrs } });
}
