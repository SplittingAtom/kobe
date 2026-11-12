/**
 * Which issuer a provider may name (spec sso-oidc-scim §4, §5.2, §13; KOBE-626). Entra issuers are
 * built from the directory (tenant) id, never typed: `https://login.microsoftonline.com/<tid>/v2.0`.
 * A multi-tenant authority (`common`, `organizations`, `consumers`) or Entra's `{tenantid}`
 * placeholder is refused for every kind, so a token from another tenant can never be accepted.
 */

export const ENTRA_AUTHORITY = "https://login.microsoftonline.com";

/** Entra's multi-tenant authorities: any tenant (or any personal account) could sign in. */
export const MULTI_TENANT_SEGMENTS = ["common", "organizations", "consumers"] as const;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export type IssuerFailure = "multi_tenant_issuer" | "invalid_tenant" | "invalid_issuer";

export type IssuerCheck =
  | { readonly ok: true; readonly issuer: string }
  | { readonly ok: false; readonly code: IssuerFailure; readonly message: string };

const MESSAGES: Readonly<Record<IssuerFailure, string>> = {
  multi_tenant_issuer:
    "Kobe accepts only a tenant-specific issuer: common, organizations and consumers let any tenant sign in.",
  invalid_tenant: "Give the directory (tenant) ID: a GUID from the app registration's Overview.",
  invalid_issuer: "Give the issuer as an https:// URL without a query, fragment or credentials.",
};

const refuse = (code: IssuerFailure): IssuerCheck => ({ ok: false, code, message: MESSAGES[code] });

/** The Entra v2.0 issuer of one tenant. */
export function entraIssuer(tenantId: string): string {
  return `${ENTRA_AUTHORITY}/${tenantId.toLowerCase()}/v2.0`;
}

/** Whether a URL path names a multi-tenant authority or Entra's `{tenantid}` placeholder. */
function multiTenant(url: URL): boolean {
  if (/%7b|%7d|[{}]/i.test(url.href)) return true;
  const segments = url.pathname.split("/").map((s) => decodeURIComponent(s).toLowerCase());
  return segments.some((s) => (MULTI_TENANT_SEGMENTS as readonly string[]).includes(s));
}

/** Validates a generic OIDC issuer as configured (the exact string discovery must report). */
export function checkGenericIssuer(raw: string): IssuerCheck {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return refuse("invalid_issuer");
  }
  if (
    url.protocol !== "https:" ||
    url.search !== "" ||
    raw.includes("?") ||
    url.hash !== "" ||
    raw.includes("#") ||
    url.username !== "" ||
    url.password !== "" ||
    /\s/.test(raw) ||
    raw.length > 2048
  ) {
    return refuse("invalid_issuer");
  }
  if (multiTenant(url)) return refuse("multi_tenant_issuer");
  return { ok: true, issuer: raw };
}

/**
 * The issuer of an Entra provider from its tenant id. The words `common`, `organizations` and
 * `consumers` are refused with their own message (they are what people paste by mistake).
 */
export function checkEntraTenant(raw: string): IssuerCheck {
  const tenant = raw.trim().toLowerCase();
  if ((MULTI_TENANT_SEGMENTS as readonly string[]).includes(tenant)) {
    return refuse("multi_tenant_issuer");
  }
  if (!UUID.test(tenant)) return refuse("invalid_tenant");
  return { ok: true, issuer: entraIssuer(tenant) };
}

/** The issuer a provider configuration names, by kind. */
export function issuerFor(
  config:
    | { readonly kind: "entra"; readonly tenantId: string }
    | { readonly kind: "oidc"; readonly issuer: string },
): IssuerCheck {
  return config.kind === "entra"
    ? checkEntraTenant(config.tenantId)
    : checkGenericIssuer(config.issuer);
}
