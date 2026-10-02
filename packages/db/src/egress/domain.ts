import { isIP } from "node:net";
import { domainToASCII } from "node:url";

/**
 * Egress domain patterns (spec D28). A pattern is a lowercase ASCII host name (IDNA, so
 * `bücher.example` is stored as `xn--bcher-kva.example`) or `*.` + a host name, which matches every
 * subdomain at any depth but never the name itself. The last label must start with a letter, so an
 * IP address is never a pattern. The schema's CHECK constraint (DOMAIN_PATTERN_SQL) is the same
 * grammar.
 */
const LABEL = "[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?";
const HOST = new RegExp(`^(${LABEL}\\.)+[a-z]([a-z0-9-]{0,61}[a-z0-9])?$`);
export const MAX_HOST_LENGTH = 253;
const WILDCARD = "*.";

/** A canonical host name, or null for anything that is not one (IP literals included). */
export function normalizeHost(raw: string): string | null {
  if (typeof raw !== "string" || raw.length === 0 || raw.length > 1024) return null;
  let host = raw.trim();
  if (host.endsWith(".")) host = host.slice(0, -1);
  if (host === "" || isIP(host) !== 0 || host.startsWith("[")) return null;
  const ascii = domainToASCII(host).toLowerCase();
  if (ascii === "" || ascii.length > MAX_HOST_LENGTH || !HOST.test(ascii)) return null;
  return ascii;
}

export type PatternResult =
  { readonly ok: true; readonly pattern: string } | { readonly ok: false; readonly reason: string };

/** Validates and canonicalizes an admin-entered pattern (`example.com` or `*.example.com`). */
export function parseDomainPattern(raw: string): PatternResult {
  if (typeof raw !== "string") return { ok: false, reason: "must be a string" };
  const trimmed = raw.trim().toLowerCase();
  const wildcard = trimmed.startsWith(WILDCARD);
  const rest = wildcard ? trimmed.slice(WILDCARD.length) : trimmed;
  if (rest.includes("*")) {
    return { ok: false, reason: "a wildcard is allowed only as the first label (*.example.com)" };
  }
  if (rest.includes("/") || rest.includes(":") || rest.includes("@")) {
    return { ok: false, reason: "enter a host name only, without scheme, port or path" };
  }
  const host = normalizeHost(rest);
  if (host === null) {
    return { ok: false, reason: "must be a host name such as pypi.org (no IP addresses)" };
  }
  const pattern = wildcard ? `${WILDCARD}${host}` : host;
  if (pattern.length > MAX_HOST_LENGTH) return { ok: false, reason: "is too long" };
  if (wildcard && !host.includes(".")) {
    return { ok: false, reason: "a wildcard needs at least two labels after it (*.example.com)" };
  }
  return { ok: true, pattern };
}

/** Whether `pattern` (canonical) covers `host` (canonical, from normalizeHost). */
export function patternMatches(pattern: string, host: string): boolean {
  if (!pattern.startsWith(WILDCARD)) return pattern === host;
  const suffix = pattern.slice(1); // ".example.com"
  return host.length > suffix.length && host.endsWith(suffix);
}

/**
 * The pattern in `patterns` that covers `host`, if any: the exact name first, then wildcards from
 * the most specific parent up. O(labels) lookups in a set.
 */
export function findMatchingPattern(
  patterns: ReadonlySet<string>,
  host: string,
): string | undefined {
  if (patterns.has(host)) return host;
  let dot = host.indexOf(".");
  while (dot !== -1) {
    const candidate = `${WILDCARD}${host.slice(dot + 1)}`;
    if (patterns.has(candidate)) return candidate;
    dot = host.indexOf(".", dot + 1);
  }
  return undefined;
}
