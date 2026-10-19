/**
 * MCP Apps frame pieces shared by the template preview (KOBE-434) and, later, the app frame
 * (MA-5): the iframe's sandbox and the restrictive CSP injected into the template (spec T2, T3).
 * A template's own declared `_meta.ui.csp` is ignored in v1: no app gets network access.
 */

/** Scripts only: no same-origin (opaque origin), forms, popups, modals, downloads or navigation. */
export const APP_FRAME_SANDBOX = "allow-scripts";

/** The ext-apps restrictive default (spec T3). */
export const APP_FRAME_CSP =
  "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; " +
  "img-src data: blob:; font-src data:; media-src 'none'; connect-src 'none'; " +
  "frame-src 'none'; worker-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'";

const META = `<meta http-equiv="Content-Security-Policy" content="${APP_FRAME_CSP}">`;

/**
 * The template with the CSP `<meta>` as the first element of `<head>` (one is added when the
 * document has none), so it applies before anything the template declares.
 */
export function withAppCsp(html: string): string {
  const head = /<head(\s[^>]*)?>/i.exec(html);
  if (head) {
    const at = head.index + head[0].length;
    return html.slice(0, at) + META + html.slice(at);
  }
  const htmlTag = /<html(\s[^>]*)?>/i.exec(html);
  if (htmlTag) {
    const at = htmlTag.index + htmlTag[0].length;
    return `${html.slice(0, at)}<head>${META}</head>${html.slice(at)}`;
  }
  return `<head>${META}</head>${html}`;
}
