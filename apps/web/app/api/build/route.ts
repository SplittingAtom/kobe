import { CLIENT_BUILD_ID } from "../../../lib/build/build-id";

export const dynamic = "force-dynamic";

/**
 * The build this web server runs (KOBE-487): open tabs compare it with their own and offer a
 * reload after a deploy. Unauthenticated on purpose: it holds nothing but the build id.
 */
export function GET(): Response {
  return Response.json({ buildId: CLIENT_BUILD_ID }, { headers: { "cache-control": "no-store" } });
}
