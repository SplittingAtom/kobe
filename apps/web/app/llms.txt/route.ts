import { PAGES } from "../../lib/docs/guide";
import { llmsTxt, textResponse } from "../../lib/docs/llms";
import { llmsContext } from "../../lib/docs/routes";

export const dynamic = "force-dynamic";

/** KOBE-616: the guide's index for agents (llmstxt.org); public, no team or user data. */
export async function GET(request: Request): Promise<Response> {
  return textResponse(request, llmsTxt(PAGES, await llmsContext(request)), "text/plain");
}
