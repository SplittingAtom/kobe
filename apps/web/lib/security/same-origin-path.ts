/**
 * Whether `path` is an absolute path on this origin: starts with one `/`, never `//` (a
 * protocol-relative URL to another host) and has no backslash (browsers read `/\host` as `//host`)
 * or whitespace. Used for API calls (lib/api/client.ts) and for the branding's asset URLs, which
 * become `<img src>` and `<link rel=icon>` on every page (lib/theme/branding-server.ts).
 */
export function isSameOriginPath(path: string): boolean {
  return /^\/(?!\/)[^\s\\]*$/.test(path);
}
