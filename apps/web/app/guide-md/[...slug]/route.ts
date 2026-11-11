import { pageBySlug } from "../../../lib/docs/guide";
import { pageMarkdown, textResponse } from "../../../lib/docs/llms";
import { llmsContext } from "../../../lib/docs/routes";

export const dynamic = "force-dynamic";

/**
 * KOBE-616: one guide page as Markdown. Served at /docs/<slug>.md (next.config.ts rewrites it
 * here: /docs/[[...slug]] is the page viewer). Public, no team or user data.
 */
export async function GET(
  request: Request,
  { params }: { params: Promise<{ slug: string[] }> },
): Promise<Response> {
  const { slug } = await params;
  const path = slug.map((s) => decodeURIComponent(s)).join("/");
  const page = path.endsWith(".md") ? pageBySlug(path.slice(0, -".md".length)) : null;
  if (page === null)
    return new Response("Not found\n", {
      status: 404,
      headers: { "content-type": "text/plain; charset=utf-8" },
    });
  const { origin } = await llmsContext(request);
  return textResponse(request, pageMarkdown(page, origin), "text/markdown");
}
