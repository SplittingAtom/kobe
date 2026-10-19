import { createHash } from "node:crypto";
import { isSameSiteFrameRequest } from "../artifacts/serve.js";

/**
 * How Kobe serves an MCP Apps template to a frame (spec MA4 as amended 2026-10-19, coordinator
 * decision on KOBE-434 Q1): like D25 artifacts, from a Kobe frame route, `text/html` only with
 * this header CSP. `sandbox allow-scripts` (no `allow-same-origin`) gives the document an opaque
 * origin even when opened top-level, so it never runs as Kobe's origin; nothing but inline
 * script and style may run, and it reaches no network. No meta CSP and no `srcdoc`: a `srcdoc`
 * document inherits Kobe's page CSP, which blocks the template's inline scripts.
 *
 * Used by the site-admin review preview (KOBE-434) and the member frame route (KOBE-437,
 * `GET /v1/team/apps/:appId/frame`), which serves only pinned, approved templates. The two
 * routes stay separate; they share these headers and the helpers below.
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

/**
 * Whether a request may load an app frame (shared by the admin preview and the member route):
 * from Kobe's own page (`isSameSiteFrameRequest`), and, when the browser says what it loads,
 * only as an iframe (KOBE-436 review LOW-1: a top-level copy would show upstream bytes under
 * Kobe's URL and could navigate itself anywhere).
 */
export function mayLoadAppFrame(headers: Headers, publicUrl: string): boolean {
  const dest = headers.get("sec-fetch-dest");
  return isSameSiteFrameRequest(headers, publicUrl) && (dest === null || dest === "iframe");
}

/**
 * The frame document, or `stale` when the caller named other bytes than the stored ones
 * (`wanted`: the hex SHA-256 the page was given; a template changed in between is refused).
 */
export function appFrameDocument(html: string, wanted: string | undefined): Response | "stale" {
  if (wanted !== undefined && sha256Hex(html) !== wanted) return "stale";
  return new Response(html, { headers: APP_FRAME_HEADERS });
}

const sha256Hex = (text: string) => createHash("sha256").update(text, "utf8").digest("hex");
