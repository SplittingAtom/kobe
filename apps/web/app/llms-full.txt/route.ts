import { PAGES } from "../../lib/docs/guide";
import { llmsFullTxt, textResponse } from "../../lib/docs/llms";
import { llmsContext } from "../../lib/docs/routes";

export const dynamic = "force-dynamic";

/** KOBE-616: every guide page's Markdown in one file; public, no team or user data. */
export async function GET(request: Request): Promise<Response> {
  return textResponse(request, llmsFullTxt(PAGES, await llmsContext(request)), "text/plain");
}
