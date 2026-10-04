import type { ProviderKind } from "../../../lib/admin/api/install/models";

/**
 * What each provider kind needs (mirrors the server's rules in `models/schemas.ts` and
 * `admin-store.ts endpointProblem`; courtesy only, the server decides and its refusal is shown).
 */
export interface KindInfo {
  readonly label: string;
  /** Vendor kinds talk to their vendor's endpoint; the others need a base URL. */
  readonly endpoint: "vendor" | "required";
  readonly key: "required" | "optional";
  /** One per install, with the kind as its id (vendor kinds and Ollama). */
  readonly single: boolean;
  readonly urlPlaceholder?: string;
  readonly hint: string;
}

export const KINDS: Readonly<Record<ProviderKind, KindInfo>> = {
  openai: {
    label: "OpenAI",
    endpoint: "vendor",
    key: "required",
    single: true,
    hint: "OpenAI's own API with an API key from platform.openai.com.",
  },
  anthropic: {
    label: "Anthropic",
    endpoint: "vendor",
    key: "required",
    single: true,
    hint: "Anthropic's Messages API (prompt caching and extended thinking kept) with an API key.",
  },
  gemini: {
    label: "Google Gemini",
    endpoint: "vendor",
    key: "required",
    single: true,
    hint: "The Gemini API with an API key from Google AI Studio.",
  },
  ollama: {
    label: "Ollama",
    endpoint: "required",
    key: "optional",
    single: true,
    urlPlaceholder: "https://ollama.com",
    hint: "Ollama Cloud (https://ollama.com with an API key from your ollama.com account) or your own Ollama server (its URL, usually without a key; allow private network addresses for a server inside your network).",
  },
  openai_compatible: {
    label: "OpenAI-compatible endpoint",
    endpoint: "required",
    key: "optional",
    single: false,
    urlPlaceholder: "https://models.example.com",
    hint: "Any server that speaks the OpenAI chat completions API (vLLM, LM Studio, OpenRouter and others). Give its root URL without /v1; the gateway adds the API paths.",
  },
};

export const kindLabel = (kind: ProviderKind): string => KINDS[kind].label;

/** Lowercase letters, digits and dashes (the server's `PROVIDER_ID_PATTERN`). */
export const PROVIDER_ID_PATTERN = "[a-z][a-z0-9\\-]{0,30}[a-z0-9]";
/** A catalog alias (the server's `MODEL_ALIAS_PATTERN`). */
export const ALIAS_PATTERN = "[a-z0-9]([a-z0-9._\\-]{0,62}[a-z0-9])?";

/** A key over plain http would be refused by the server (`insecure_endpoint`). */
export function insecureForKey(baseUrl: string, hasKey: boolean): boolean {
  return hasKey && /^http:\/\//i.test(baseUrl.trim());
}
