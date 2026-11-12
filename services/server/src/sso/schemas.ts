import { SSO_DEFAULT_MFA_RULE, SSO_TEXT_MAX } from "@kobe/db";
import { z } from "zod";

/**
 * Shapes of a provider's settings (spec sso-oidc-scim §4, §8; KOBE-626), shared by the Site console
 * API and the chart's `auth.sso.providers` (start-up upsert), so both accept the same values.
 */

export const slugSchema = z.string().regex(/^[a-z0-9][a-z0-9-]{0,62}$/, {
  error: "Use 1 to 63 lowercase letters, digits and hyphens (not starting with a hyphen).",
});

export const displayNameSchema = z.string().trim().min(1).max(100);

export const clientIdSchema = z
  .string()
  .trim()
  .min(1)
  .max(SSO_TEXT_MAX)
  .regex(/^[\x21-\x7e]+$/, { error: "The client ID is visible characters without spaces." });

/** A client secret as typed: visible characters, at most 1 KiB (Entra's are 40). */
export const clientSecretSchema = z
  .string()
  .min(1)
  .max(1024)
  .regex(/^[\x20-\x7e]+$/, { error: "The client secret is visible characters." });

const claimValues = z
  .array(
    z
      .string()
      .min(1)
      .max(64)
      .regex(/^[\x21-\x7e]+$/),
  )
  .max(20);

/** §8: which `amr`, `acr` or Entra `acrs` values prove multi-factor authentication. */
export const mfaRuleSchema = z
  .object({ amr_any: claimValues, acr_any: claimValues, acrs_any: claimValues })
  .strict();
export type MfaRule = z.infer<typeof mfaRuleSchema>;

/**
 * The Entra preset (§8): Entra v2.0 ID tokens do not reliably carry `amr`, so the admin creates a
 * Conditional Access authentication context `c1` that requires MFA and Kobe asks for it. SSO-4
 * verifies the preset against a real tenant.
 */
export const ENTRA_MFA_RULE: MfaRule = {
  amr_any: [...SSO_DEFAULT_MFA_RULE.amr_any],
  acr_any: [],
  acrs_any: ["c1"],
};
export const GENERIC_MFA_RULE: MfaRule = {
  amr_any: [...SSO_DEFAULT_MFA_RULE.amr_any],
  acr_any: [],
  acrs_any: [],
};

export const emailDomainsSchema = z
  .array(
    z
      .string()
      .trim()
      .toLowerCase()
      .max(253)
      .regex(/^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/, {
        error: "Give domains like example.com.",
      }),
  )
  .max(50);

export const accessClaimSchema = z.enum(["roles", "groups"]);
export const subjectClaimSchema = z.enum(["oid", "sub"]);
export const maxSessionHoursSchema = z.number().int().min(1).max(8760);

/** The defaults of a kind (Entra: `oid` subject, the `acrs` MFA preset; generic: `sub`). */
export function kindDefaults(kind: "entra" | "oidc"): {
  subjectClaim: "oid" | "sub";
  mfaRule: MfaRule;
} {
  return kind === "entra"
    ? { subjectClaim: "oid", mfaRule: ENTRA_MFA_RULE }
    : { subjectClaim: "sub", mfaRule: GENERIC_MFA_RULE };
}
