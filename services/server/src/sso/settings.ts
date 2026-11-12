import { validateCidrs, validateInternalTargets } from "@kobe/address-policy";
import { z } from "zod";
import { DEFAULT_ALLOWED_PORTS, resolveAll } from "../connectors/url-policy.js";
import { checkEntraTenant, checkGenericIssuer } from "./issuer.js";
import { SSO_TIMEOUT_MS, type SsoNet } from "./net.js";
import {
  accessClaimSchema,
  clientIdSchema,
  clientSecretSchema,
  displayNameSchema,
  emailDomainsSchema,
  kindDefaults,
  maxSessionHoursSchema,
  mfaRuleSchema,
  slugSchema,
  subjectClaimSchema,
  type MfaRule,
} from "./schemas.js";

/**
 * Single sign-on settings from the chart (`auth.sso`, spec sso-oidc-scim §4, §11; KOBE-626):
 *
 * - `KOBE_SSO_ENABLED` — the kill switch. `false` hides every SSO route and console page and
 *   refuses SSO sign-in, without a database change; local sign-in is unaffected. Unset: off.
 * - `KOBE_SSO_ALLOWED_INTERNAL_CIDRS`, `KOBE_SSO_ALLOWED_PORTS` — the SSRF guard's exceptions for an
 *   on-premises IdP (private addresses, a port other than 443).
 * - `KOBE_SSO_PROVIDERS` — JSON array of the Helm-declared providers (no secrets), upserted at start
 *   as `managed_by: helm`.
 * - `KOBE_SSO_CLIENT_SECRET_<SLUG>` — each Helm provider's client secret, from the Kubernetes Secret
 *   its values name; held in memory only, never copied into the database.
 */

export interface HelmSsoProvider {
  readonly slug: string;
  readonly displayName: string;
  readonly kind: "entra" | "oidc";
  /** Entra: the directory (tenant) id; null for generic providers. */
  readonly tenantId: string | null;
  /** The exact issuer (Entra: built from the tenant id). */
  readonly issuer: string;
  readonly clientId: string;
  readonly subjectClaim: "oid" | "sub";
  readonly accessClaim: "roles" | "groups";
  readonly mfaRule: MfaRule;
  readonly allowedEmailDomains: readonly string[];
  readonly jitProvisioning: boolean;
  readonly enabled: boolean;
  readonly maxSessionHours: number | null;
}

export interface SsoSettings {
  readonly enabled: boolean;
  readonly allowedInternalCidrs: readonly string[];
  readonly allowedPorts: readonly number[];
  readonly helmProviders: readonly HelmSsoProvider[];
  /** Helm providers' client secrets by slug (only those whose Secret was mounted). */
  readonly helmSecrets: ReadonlyMap<string, string>;
}

export const SSO_OFF: SsoSettings = {
  enabled: false,
  allowedInternalCidrs: [],
  allowedPorts: DEFAULT_ALLOWED_PORTS,
  helmProviders: [],
  helmSecrets: new Map(),
};

/** The env var holding a Helm provider's client secret (slugs have no `_`, so this is 1:1). */
export function secretEnvName(slug: string): string {
  return `KOBE_SSO_CLIENT_SECRET_${slug.toUpperCase().replace(/-/g, "_")}`;
}

const helmProviderSchema = z
  .object({
    slug: slugSchema,
    displayName: displayNameSchema,
    kind: z.enum(["entra", "oidc"]),
    tenantId: z.string().optional(),
    issuer: z.string().optional(),
    clientId: clientIdSchema,
    subjectClaim: subjectClaimSchema.optional(),
    accessClaim: accessClaimSchema.default("roles"),
    mfaRule: mfaRuleSchema.optional(),
    allowedEmailDomains: emailDomainsSchema.default([]),
    jitProvisioning: z.boolean().default(true),
    enabled: z.boolean().default(true),
    maxSessionHours: maxSessionHoursSchema.nullish(),
  })
  .strict();

type Env = Readonly<Record<string, string | undefined>>;

const fail = (message: string): never => {
  throw new Error(`Invalid configuration: ${message}`);
};

function list(value: string | undefined): string[] {
  return (value ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s !== "");
}

function helmProvider(raw: unknown, index: number): HelmSsoProvider {
  const parsed = helmProviderSchema.safeParse(raw);
  if (!parsed.success) {
    // Paths and messages only, never values.
    const issues = parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
    return fail(`auth.sso.providers[${index}]: ${issues}`);
  }
  const p = parsed.data;
  const where = `auth.sso.providers[${index}] (${p.slug})`;
  let tenantId: string | null = null;
  let issuer: string;
  if (p.kind === "entra") {
    if (p.issuer !== undefined) fail(`${where}: an Entra provider names tenantId, not issuer`);
    const check = checkEntraTenant(p.tenantId ?? "");
    if (!check.ok) return fail(`${where}: ${check.message}`);
    tenantId = (p.tenantId ?? "").trim().toLowerCase();
    issuer = check.issuer;
  } else {
    if (p.tenantId !== undefined) fail(`${where}: a generic provider names issuer, not tenantId`);
    const check = checkGenericIssuer(p.issuer ?? "");
    if (!check.ok) return fail(`${where}: ${check.message}`);
    issuer = check.issuer;
  }
  const defaults = kindDefaults(p.kind);
  return {
    slug: p.slug,
    displayName: p.displayName,
    kind: p.kind,
    tenantId,
    issuer,
    clientId: p.clientId,
    subjectClaim: p.subjectClaim ?? defaults.subjectClaim,
    accessClaim: p.accessClaim,
    mfaRule: p.mfaRule ?? defaults.mfaRule,
    allowedEmailDomains: p.allowedEmailDomains,
    jitProvisioning: p.jitProvisioning,
    enabled: p.enabled,
    maxSessionHours: p.maxSessionHours ?? null,
  };
}

export function loadSsoSettings(env: Env): SsoSettings {
  const flag = env.KOBE_SSO_ENABLED ?? "false";
  if (flag !== "true" && flag !== "false") fail("KOBE_SSO_ENABLED must be true or false");
  const cidrs = list(env.KOBE_SSO_ALLOWED_INTERNAL_CIDRS);
  try {
    validateCidrs(cidrs);
    validateInternalTargets(cidrs);
  } catch {
    fail("KOBE_SSO_ALLOWED_INTERNAL_CIDRS must be a comma-separated list of private CIDRs");
  }
  const ports = list(env.KOBE_SSO_ALLOWED_PORTS).map(Number);
  if (ports.some((p) => !Number.isInteger(p) || p < 1 || p > 65535)) {
    fail("KOBE_SSO_ALLOWED_PORTS must be ports (1-65535)");
  }
  let raw: unknown = [];
  if (env.KOBE_SSO_PROVIDERS !== undefined && env.KOBE_SSO_PROVIDERS.trim() !== "") {
    try {
      raw = JSON.parse(env.KOBE_SSO_PROVIDERS);
    } catch {
      fail("KOBE_SSO_PROVIDERS must be a JSON array");
    }
  }
  if (!Array.isArray(raw)) return fail("KOBE_SSO_PROVIDERS must be a JSON array");
  if (raw.length > 20) fail("auth.sso.providers: at most 20 providers");
  const helmProviders = raw.map((p, i) => helmProvider(p, i));
  const slugs = new Set<string>();
  const helmSecrets = new Map<string, string>();
  for (const p of helmProviders) {
    if (slugs.has(p.slug)) fail(`auth.sso.providers: slug ${p.slug} appears twice`);
    slugs.add(p.slug);
    const secret = env[secretEnvName(p.slug)];
    if (secret === undefined || secret === "") continue;
    if (!clientSecretSchema.safeParse(secret).success) {
      fail(`${secretEnvName(p.slug)} must be visible characters, at most 1024`);
    }
    helmSecrets.set(p.slug, secret);
  }
  return {
    enabled: flag === "true",
    allowedInternalCidrs: cidrs,
    allowedPorts: ports.length === 0 ? DEFAULT_ALLOWED_PORTS : ports,
    helmProviders,
    helmSecrets,
  };
}

/** The SSRF policy SSO's outbound calls use (https only; private ranges only when listed). */
export function ssoNet(
  settings: SsoSettings,
  overrides: Partial<SsoNet["policy"]> = {},
  request?: SsoNet["request"],
): SsoNet {
  return {
    ...(request ? { request } : {}),
    timeoutMs: SSO_TIMEOUT_MS,
    policy: {
      allowHttp: false,
      allowedPorts: settings.allowedPorts,
      allowedInternalCidrs: settings.allowedInternalCidrs,
      deniedCidrs: [],
      resolve: resolveAll,
      ...overrides,
    },
  };
}
