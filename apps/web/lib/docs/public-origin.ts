/**
 * The origin the guide's Markdown outputs put in front of their links (KOBE-616): the deployment's
 * KOBE_PUBLIC_URL when set (the chart sets the same value as the server's), else the request's
 * own host as the ingress forwarded it (`X-Forwarded-Proto`/`-Host`, then `Host`, then the URL).
 * A host that is not a plain `host[:port]` is ignored, so nothing odd reaches the text.
 */
const HOST = /^[a-z0-9.-]+(?::\d{1,5})?$|^\[[0-9a-f:.]+\](?::\d{1,5})?$/i;

function first(value: string | null): string | null {
  const v = value?.split(",")[0]?.trim();
  return v ? v : null;
}

export function publicOrigin(request: Request, configured: string | null): string {
  if (configured !== null) return configured;
  const url = new URL(request.url);
  const proto = first(request.headers.get("x-forwarded-proto"));
  const host = first(request.headers.get("x-forwarded-host")) ?? first(request.headers.get("host"));
  const scheme = proto === "http" || proto === "https" ? proto : url.protocol.slice(0, -1);
  if (host !== null && HOST.test(host)) return `${scheme}://${host.toLowerCase()}`;
  return url.origin;
}
