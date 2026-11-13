/**
 * Where an SSO sign-in lands afterwards (spec sso-oidc-scim §5.3, §13 open redirect): only a
 * relative path on Kobe's own origin. Anything else (`//host`, `/\host`, a scheme, an encoded
 * slash or backslash, control characters, an overlong value) becomes `/`.
 */

export const RETURN_TO_MAX = 2048;
const BASE = "https://kobe.invalid";

export function safeReturnTo(raw: unknown): string {
  if (typeof raw !== "string" || raw.length === 0 || raw.length > RETURN_TO_MAX) return "/";
  // One leading slash, then not a slash or backslash (protocol-relative and Windows-style tricks).
  if (!raw.startsWith("/") || raw.startsWith("//") || raw.startsWith("/\\")) return "/";
  // Control characters and backslashes anywhere (browsers strip tabs/newlines and fold `\` to `/`).
  if ([...raw].some((ch) => ch.charCodeAt(0) < 0x20 || ch === "\u007f" || ch === "\\")) return "/";
  // Encoded slashes or backslashes some servers and proxies decode before routing.
  if (/%2f|%5c/i.test(raw)) return "/";
  let url: URL;
  try {
    url = new URL(raw, BASE);
  } catch {
    return "/";
  }
  if (url.origin !== BASE) return "/";
  return `${url.pathname}${url.search}${url.hash}`;
}
