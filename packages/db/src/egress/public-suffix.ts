import { parse } from "tldts";

/**
 * Public-suffix and shared-hosting checks for egress patterns (KOBE-38 review). Uses the Public
 * Suffix List (ICANN and private sections, via `tldts`, MIT):
 *
 * - A wildcard directly on a public suffix (`*.co.uk`, `*.github.io`, `*.cloudfront.net`) would
 *   admit every customer of that registry or host: refused.
 * - A pattern on shared hosting or a CDN (PSL private section, plus CDN domains known for
 *   fronting that are not in the PSL) is allowed but flagged: TLS SNI shows only the front name,
 *   and a client can ask the CDN for another customer's site inside the encrypted request
 *   (domain fronting), which the proxy cannot see without decrypting.
 */
const FRONTING_CDNS = [
  "akamaihd.net",
  "akamaized.net",
  "akamaiedge.net",
  "edgekey.net",
  "edgesuite.net",
  "fastly.net",
  "fastlylb.net",
  "azureedge.net",
  "azurefd.net",
  "cloudflare.net",
  "cloudfront.net",
  "b-cdn.net",
  "googleusercontent.com",
  "appspot.com",
  "cdn77.org",
  "llnwd.net",
] as const;

const PSL = { allowPrivateDomains: true } as const;

/** Whether `name` (canonical host) is itself a public suffix (ICANN or private section). */
export function isPublicSuffix(name: string): boolean {
  return parse(name, PSL).publicSuffix === name;
}

/** Why a canonical pattern is not acceptable, or undefined. */
export function publicSuffixProblem(pattern: string): string | undefined {
  if (!pattern.startsWith("*.")) return undefined;
  const base = pattern.slice(2);
  return isPublicSuffix(base)
    ? `a wildcard on the public suffix ${base} would match every site under it`
    : undefined;
}

/** Whether the pattern points at shared hosting or a CDN (domain fronting possible). */
export function isSharedHosting(pattern: string): boolean {
  const host = pattern.startsWith("*.") ? pattern.slice(2) : pattern;
  if (FRONTING_CDNS.some((cdn) => host === cdn || host.endsWith(`.${cdn}`))) return true;
  return parse(host, PSL).isPrivate === true;
}
