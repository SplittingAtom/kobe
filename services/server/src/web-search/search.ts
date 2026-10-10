import {
  WEB_SEARCH_COUNT_DEFAULT,
  WEB_SEARCH_SNIPPET_MAX,
  WEB_SEARCH_TITLE_MAX,
  WEB_SEARCH_URL_MAX,
  type WebSearchCitation,
  type WebSearchInput,
} from "@kobe/protocol";
import type { WebSearchProvider } from "@kobe/db";
import { providerInfo } from "./providers.js";

/**
 * One search against the install's provider. Runs in the server process: the key is opened here,
 * sent to the provider's fixed API host (`providers.ts`) and goes nowhere else. Nothing a provider
 * says (status text, body) is passed on beyond the citations we parse, so an error cannot echo the
 * key back to a sandbox.
 */
export const SEARCH_TIMEOUT_MS = 10_000;
export const SEARCH_MAX_RESPONSE_BYTES = 1024 * 1024;

export type SearchOutcome =
  | { readonly ok: true; readonly results: readonly WebSearchCitation[] }
  | {
      readonly ok: false;
      readonly code: "search_failed" | "rate_limited";
      readonly message: string;
    };

const FAILED: SearchOutcome = {
  ok: false,
  code: "search_failed",
  message: "The search provider did not answer. Try again later.",
};

const ENTITIES: Readonly<Record<string, string>> = {
  "&amp;": "&",
  "&lt;": "<",
  "&gt;": ">",
  "&quot;": '"',
  "&#39;": "'",
  "&nbsp;": " ",
};

/** Plain text from a snippet that may carry markup (Brave bolds matches). */
function plain(value: unknown, max: number): string {
  if (typeof value !== "string") return "";
  const text = value
    .replace(/<[^>]*>/g, "")
    .replace(/&(?:amp|lt|gt|quot|#39|nbsp);/g, (e) => ENTITIES[e] ?? e)
    .replace(/\s+/g, " ")
    .trim();
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

function citation(raw: unknown, snippet: unknown): WebSearchCitation | undefined {
  const item = raw as { title?: unknown; url?: unknown } | null;
  const url = item?.url;
  if (typeof url !== "string" || url.length > WEB_SEARCH_URL_MAX || !/^https?:\/\//i.test(url)) {
    return undefined;
  }
  return {
    title: plain(item?.title, WEB_SEARCH_TITLE_MAX) || url.slice(0, WEB_SEARCH_TITLE_MAX),
    url,
    snippet: plain(snippet, WEB_SEARCH_SNIPPET_MAX),
  };
}

interface Request {
  readonly url: string;
  readonly init: RequestInit;
  readonly parse: (json: unknown) => WebSearchCitation[];
}

const list = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);
const field = (item: unknown, key: string): unknown =>
  (item as Record<string, unknown> | null)?.[key];
const compact = (items: (WebSearchCitation | undefined)[]) =>
  items.filter((c): c is WebSearchCitation => c !== undefined);

function build(provider: WebSearchProvider, key: string, query: string, count: number): Request {
  const host = providerInfo(provider).domain;
  if (provider === "brave") {
    const params = new URLSearchParams({ q: query, count: String(count) });
    return {
      url: `https://${host}/res/v1/web/search?${params.toString()}`,
      init: { method: "GET", headers: { Accept: "application/json", "X-Subscription-Token": key } },
      parse: (json) =>
        compact(
          list(field(field(json, "web"), "results")).map((r) =>
            citation(r, field(r, "description")),
          ),
        ),
    };
  }
  const post = (headers: Record<string, string>, body: unknown): Request["init"] => ({
    method: "POST",
    headers: { Accept: "application/json", "Content-Type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
  if (provider === "tavily") {
    return {
      url: `https://${host}/search`,
      init: post({ Authorization: `Bearer ${key}` }, { query, max_results: count }),
      parse: (json) =>
        compact(list(field(json, "results")).map((r) => citation(r, field(r, "content")))),
    };
  }
  return {
    url: `https://${host}/search`,
    init: post(
      { "x-api-key": key },
      { query, numResults: count, contents: { text: { maxCharacters: WEB_SEARCH_SNIPPET_MAX } } },
    ),
    parse: (json) =>
      compact(list(field(json, "results")).map((r) => citation(r, field(r, "text")))),
  };
}

async function readCapped(res: Response): Promise<string | undefined> {
  const reader = res.body?.getReader();
  if (!reader) return "";
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > SEARCH_MAX_RESPONSE_BYTES) {
      await reader.cancel();
      return undefined;
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString("utf8");
}

export async function searchProvider(
  provider: WebSearchProvider,
  key: string,
  input: WebSearchInput,
  fetchFn: typeof fetch = fetch,
): Promise<SearchOutcome> {
  const request = build(provider, key, input.query, input.count ?? WEB_SEARCH_COUNT_DEFAULT);
  try {
    const res = await fetchFn(request.url, {
      ...request.init,
      redirect: "error",
      signal: AbortSignal.timeout(SEARCH_TIMEOUT_MS),
    });
    if (res.status === 429) {
      await res.body?.cancel();
      return { ok: false, code: "rate_limited", message: "The search provider is rate limiting." };
    }
    if (res.status !== 200) {
      await res.body?.cancel();
      return FAILED;
    }
    const text = await readCapped(res);
    if (text === undefined) return FAILED;
    const results = request
      .parse(JSON.parse(text))
      .slice(0, input.count ?? WEB_SEARCH_COUNT_DEFAULT);
    return { ok: true, results };
  } catch {
    return FAILED;
  }
}
