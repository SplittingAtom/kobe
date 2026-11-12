/**
 * The guide's text routes' HTTP side (KOBE-616). The texts themselves (`llmsTxt`, `llmsFullTxt`,
 * `pageMarkdown`) come from `@kobe/guide` (KOBE-620), shared with the server's docs tools.
 */
export { llmsFullTxt, llmsTxt, pageMarkdown, pageMarkdownUrl, type LlmsContext } from "@kobe/guide";

/** A weak ETag over the body (FNV-1a, 32 bit): the same text gets the same tag on every replica. */
export function etagOf(body: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < body.length; i++) {
    h ^= body.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return `W/"${(h >>> 0).toString(16)}-${body.length.toString(16)}"`;
}

/** Five minutes in caches, then revalidated by ETag; public: the guide holds no one's data. */
export const GUIDE_CACHE_CONTROL = "public, max-age=300, must-revalidate";

export function textResponse(
  request: Request,
  body: string,
  type: "text/plain" | "text/markdown",
): Response {
  const etag = etagOf(body);
  const headers = {
    "content-type": `${type}; charset=utf-8`,
    "cache-control": GUIDE_CACHE_CONTROL,
    etag,
    "x-content-type-options": "nosniff",
  };
  const match = request.headers.get("if-none-match");
  if (match !== null && match.split(",").some((t) => t.trim() === etag))
    return new Response(null, { status: 304, headers });
  return new Response(request.method === "HEAD" ? null : body, { status: 200, headers });
}
