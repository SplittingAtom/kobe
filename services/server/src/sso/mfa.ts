import type { MfaRule } from "./schemas.js";

/** The MFA evidence of a validated ID token (claims.ts). */
export interface MfaProof {
  readonly amr: readonly string[];
  readonly acr: string | null;
  /** Entra authentication context class references (`acrs`); empty for other providers. */
  readonly acrs: readonly string[];
}

/**
 * Spec §8 (SSO3): the sign-in proved multi-factor authentication when any `amr` value (RFC 8176)
 * of the provider's `mfa_rule` is present, or the `acr` matches one exactly, or (Entra only) the
 * `acrs` claim carries a listed authentication context. Exact, case-sensitive matches only.
 */
export function mfaProven(kind: "entra" | "oidc", rule: MfaRule, proof: MfaProof): boolean {
  if (proof.amr.some((v) => rule.amr_any.includes(v))) return true;
  if (proof.acr !== null && rule.acr_any.includes(proof.acr)) return true;
  return kind === "entra" && proof.acrs.some((v) => rule.acrs_any.includes(v));
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
