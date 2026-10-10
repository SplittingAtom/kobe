import { WEB_SEARCH_PROVIDER_VALUES, type WebSearchProvider } from "@kobe/db";

export interface WebSearchProviderInfo {
  readonly id: WebSearchProvider;
  readonly label: string;
  /** The API host the `web_search` tool (KOBE-114) calls; added to the egress ceiling when on. */
  readonly domain: string;
}

/** The providers an install admin can choose, in display order. */
export const WEB_SEARCH_PROVIDERS: readonly WebSearchProviderInfo[] = [
  { id: "brave", label: "Brave Search", domain: "api.search.brave.com" },
  { id: "tavily", label: "Tavily", domain: "api.tavily.com" },
  { id: "exa", label: "Exa", domain: "api.exa.ai" },
];

if (WEB_SEARCH_PROVIDERS.map((p) => p.id).join() !== WEB_SEARCH_PROVIDER_VALUES.join()) {
  throw new Error("web search providers out of sync with the schema");
}

export const providerInfo = (id: WebSearchProvider): WebSearchProviderInfo => {
  const found = WEB_SEARCH_PROVIDERS.find((p) => p.id === id);
  if (!found) throw new Error("unknown web search provider");
  return found;
};
