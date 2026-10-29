import { invalidateBranding } from "../../../../lib/theme/branding-server";

export const dynamic = "force-dynamic";

/**
 * Refetches this web process's site branding now (KOBE-501): the Appearance page calls it after a
 * save, upload, removal or reset, then reloads, so the admin sees the change at once instead of
 * after the 30 s cache (TH5). Other web replicas pick it up within 30 s. It takes no input and
 * only makes this process ask the server again, so it needs no session; a same-origin check keeps
 * other sites from triggering it (Sec-Fetch-Site, else Origin against the Host).
 */
function sameOrigin(request: Request): boolean {
  const site = request.headers.get("sec-fetch-site");
  if (site !== null) return site === "same-origin";
  const origin = request.headers.get("origin");
  const host = request.headers.get("x-forwarded-host") ?? request.headers.get("host");
  if (origin === null || host === null) return false;
  try {
    return new URL(origin).host === host;
  } catch {
    return false;
  }
}

export async function POST(request: Request): Promise<Response> {
  if (!sameOrigin(request)) return new Response(null, { status: 403 });
  await invalidateBranding();
  return new Response(null, { status: 204, headers: { "cache-control": "no-store" } });
}
