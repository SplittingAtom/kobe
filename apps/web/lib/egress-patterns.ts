/**
 * The patterns an approver may pick for a blocked host (egress access, EA3): the host itself
 * first (the default), then `*.<parent>` for each parent up the chain, never a public suffix and
 * with at least two labels after `*.`. The server (`parseDomainPattern`, the Public Suffix List)
 * stays the authority and refuses anything else with `invalid_pattern`; this only keeps the
 * obvious dead ends out of the choice. The browser has no suffix list, so the common two-level
 * registries (`co.uk`, `com.au`, `ac.jp` ...) are recognised by shape.
 */
const SECOND_LEVEL = new Set(["co", "com", "org", "net", "gov", "edu", "ac", "or", "ne", "go"]);

function looksLikePublicSuffix(labels: readonly string[]): boolean {
  if (labels.length === 1) return true;
  if (labels.length === 2) {
    const [second, tld] = labels as [string, string];
    return tld.length === 2 && SECOND_LEVEL.has(second);
  }
  return false;
}

/** The host, then each wildcard parent that is neither a suffix nor one label short. */
export function patternChoices(host: string): readonly string[] {
  const labels = host.toLowerCase().split(".");
  const out = [host.toLowerCase()];
  for (let i = 1; i < labels.length; i += 1) {
    const parent = labels.slice(i);
    if (parent.length < 2 || looksLikePublicSuffix(parent)) break;
    out.push(`*.${parent.join(".")}`);
  }
  return out;
}

/** Whether `pattern` covers `host` (the server's `patternMatches`). */
export function patternCovers(pattern: string, host: string): boolean {
  if (!pattern.startsWith("*.")) return pattern === host;
  const suffix = pattern.slice(1);
  return host.length > suffix.length && host.endsWith(suffix);
}
