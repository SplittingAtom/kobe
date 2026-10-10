import { z } from "zod";
import { idSchema } from "./common.js";

/**
 * Web search contract (KOBE-114 = 63b of KOBE-63). Additive: an agent without
 * {@link CAPABILITY_WEB_SEARCH} never registers `web_search`, and no existing shape changes.
 *
 * The server performs the search. Sequence: `web_search` -> kobe-policy `policy.check` (a read
 * tool, so the engine decides as for any tool) -> kobe-tools `{op:"web_search"}` on fd 4 -> frame
 * `web_search.query` -> the server checks capability, lease and the allowed input hash (as
 * artifacts), then resolves availability (install provider enabled AND the team opted in), opens
 * the install's sealed key, calls the provider and answers `web_search.result`. The key never
 * leaves the server: the sandbox sees the query it sent and the citations that come back.
 *
 * Unavailable is an answer, not an error: `available: false` with a `reason` and a `message` the
 * model repeats to the user (the Researcher agent explains it). Real failures (provider down,
 * rate limit) are `ok: false` errors.
 */

/** `hello.capabilities` entry of an agent that registers `web_search`. */
export const CAPABILITY_WEB_SEARCH = "web_search";
export const TOOL_WEB_SEARCH = "web_search";

export const WEB_SEARCH_QUERY_MAX = 400;
export const WEB_SEARCH_COUNT_MAX = 10;
export const WEB_SEARCH_COUNT_DEFAULT = 5;
export const WEB_SEARCH_TITLE_MAX = 300;
export const WEB_SEARCH_URL_MAX = 2048;
export const WEB_SEARCH_SNIPPET_MAX = 1000;

export const webSearchInputSchema = z.strictObject({
  query: z.string().trim().min(1).max(WEB_SEARCH_QUERY_MAX),
  count: z.number().int().min(1).max(WEB_SEARCH_COUNT_MAX).optional(),
});
export type WebSearchInput = z.infer<typeof webSearchInputSchema>;

/** One citation: where the claim came from. */
export const webSearchCitationSchema = z.strictObject({
  title: z.string().max(WEB_SEARCH_TITLE_MAX),
  url: z
    .string()
    .max(WEB_SEARCH_URL_MAX)
    .regex(/^https?:\/\//i),
  snippet: z.string().max(WEB_SEARCH_SNIPPET_MAX),
});
export type WebSearchCitation = z.infer<typeof webSearchCitationSchema>;

export const WEB_SEARCH_PROVIDERS = ["brave", "tavily", "exa"] as const;
export const WEB_SEARCH_UNAVAILABLE_REASONS = ["not_configured", "team_not_enabled"] as const;

/** Fields shared by the `web_search.result` frame and the kobe-tools response (flat). */
export const webSearchOkFields = {
  ok: z.literal(true),
  available: z.literal(true),
  provider: z.enum(WEB_SEARCH_PROVIDERS),
  query: z.string().max(WEB_SEARCH_QUERY_MAX),
  results: z.array(webSearchCitationSchema).max(WEB_SEARCH_COUNT_MAX),
} as const;

export const webSearchUnavailableFields = {
  ok: z.literal(true),
  available: z.literal(false),
  reason: z.enum(WEB_SEARCH_UNAVAILABLE_REASONS),
  message: z.string().max(500),
} as const;

/** Error codes the server uses; open on the sandbox side. */
export const WEB_SEARCH_ERROR_CODES = [
  "not_allowed",
  "invalid_input",
  "rate_limited",
  "search_failed",
] as const;

/** `{ tool, input }` pair, as `artifactCallShape`. */
export const webSearchCallShape = {
  tool: z.literal(TOOL_WEB_SEARCH),
  input: webSearchInputSchema,
} as const;

/** kobe-tools request (fd 4) for `web_search`; member of `kobeToolsRequestSchema`. */
export const webSearchToolsRequestSchema = z.strictObject({
  id: idSchema,
  op: z.literal("web_search"),
  tool_call_id: idSchema,
  ...webSearchCallShape,
});

/** The message the model gets when web search is off, by reason. Kept here so tests can pin it. */
export const WEB_SEARCH_UNAVAILABLE_MESSAGES: Readonly<
  Record<(typeof WEB_SEARCH_UNAVAILABLE_REASONS)[number], string>
> = {
  not_configured: "Web search is unavailable: this Kobe install has no web search provider set up.",
  team_not_enabled:
    "Web search is unavailable: your team has not turned it on. A team admin can enable it in team settings.",
};
