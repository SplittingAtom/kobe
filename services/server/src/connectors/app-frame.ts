/**
 * How Kobe serves an MCP Apps template to a frame (spec MA4 as amended 2026-10-19, coordinator
 * decision on KOBE-434 Q1): like D25 artifacts, from a Kobe frame route, `text/html` only with
 * this header CSP. `sandbox allow-scripts` (no `allow-same-origin`) gives the document an opaque
 * origin even when opened top-level, so it never runs as Kobe's origin; nothing but inline
 * script and style may run, and it reaches no network. No meta CSP and no `srcdoc`: a `srcdoc`
 * document inherits Kobe's page CSP, which blocks the template's inline scripts.
 *
 * Used by the site-admin review preview (KOBE-434). MA-5's member frame route uses the same
 * headers but serves only pinned, approved templates; the routes stay separate.
 */
export const APP_FRAME_CSP =
  "sandbox allow-scripts; default-src 'none'; script-src 'unsafe-inline'; " +
  "style-src 'unsafe-inline'; img-src data: blob:; font-src data:; media-src 'none'; " +
  "connect-src 'none'; frame-src 'none'; worker-src 'none'; object-src 'none'; " +
  "base-uri 'none'; form-action 'none'; frame-ancestors 'self'";

export const APP_FRAME_HEADERS: Readonly<Record<string, string>> = {
  "content-type": "text/html; charset=utf-8",
  "content-security-policy": APP_FRAME_CSP,
  "x-frame-options": "SAMEORIGIN",
  "referrer-policy": "no-referrer",
  "cache-control": "private, no-store",
  "x-content-type-options": "nosniff",
};
