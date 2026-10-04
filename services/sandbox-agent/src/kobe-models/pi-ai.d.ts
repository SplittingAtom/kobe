/**
 * The slice of `@earendil-works/pi-ai` (MIT, shipped inside the pinned Pi 1.0.0) that kobe-models
 * uses, declared here so the extension compiles without the package in this workspace: Pi's
 * extension loader (jiti) resolves the specifier to its own copy at runtime (verified 1.0.0,
 * `core/extensions/loader.js` aliases). Shapes follow pi-ai's `models.d.ts`, `auth/types.d.ts`
 * and `types.d.ts`; `kobe-models.real-pi.test.ts` proves them against the real package.
 */
declare module "@earendil-works/pi-ai" {
  export type ProviderHeaders = Record<string, string | null>;

  export interface ModelAuth {
    apiKey?: string;
    headers?: ProviderHeaders;
    baseUrl?: string;
  }

  export interface AuthResult {
    auth: ModelAuth;
    source?: string;
  }

  export interface AuthCheck {
    source?: string;
    type: "api_key" | "oauth";
  }

  export interface ApiKeyAuth {
    name: string;
    check?(input: { signal: AbortSignal }): Promise<AuthCheck | undefined>;
    resolve(input: { signal: AbortSignal }): Promise<AuthResult | undefined>;
  }

  export interface ProviderAuth {
    apiKey?: ApiKeyAuth;
  }

  export interface Model {
    id: string;
    name: string;
    api: string;
    provider: string;
    baseUrl: string;
    reasoning: boolean;
    input: ("text" | "image")[];
    cost: { input: number; output: number; cacheRead: number; cacheWrite: number };
    contextWindow: number;
    maxTokens: number;
    headers?: ProviderHeaders;
  }

  export interface ProviderResponse {
    status: number;
    headers: Record<string, string>;
  }

  export interface StreamOptions {
    signal?: AbortSignal;
    apiKey?: string;
    headers?: ProviderHeaders;
    maxRetries?: number;
    onResponse?: (response: ProviderResponse, model: Model) => void | Promise<void>;
    [key: string]: unknown;
  }

  export interface AssistantMessage {
    role: "assistant";
    content: unknown[];
    api: string;
    provider: string;
    model: string;
    usage: unknown;
    stopReason: string;
    errorMessage?: string;
    timestamp: number;
    [key: string]: unknown;
  }

  export type AssistantMessageEvent =
    | { type: "error"; reason: string; error: AssistantMessage }
    | { type: "done"; reason: string; message: AssistantMessage }
    | { type: string; [key: string]: unknown };

  export interface AssistantMessageEventStream extends AsyncIterable<AssistantMessageEvent> {
    push(event: AssistantMessageEvent): void;
    end(result?: AssistantMessage): void;
    result(): Promise<AssistantMessage>;
  }

  /** A chat API implementation (`openAICompletionsApi()` etc.), opaque to kobe-models. */
  export interface ApiStreams {
    readonly api: string;
    stream(model: Model, context: unknown, options?: StreamOptions): AssistantMessageEventStream;
    streamSimple(
      model: Model,
      context: unknown,
      options?: StreamOptions,
    ): AssistantMessageEventStream;
  }

  export interface Provider {
    readonly id: string;
    readonly name: string;
    readonly baseUrl?: string;
    readonly auth: ProviderAuth;
    getModels(): readonly Model[];
    stream(model: Model, context: unknown, options?: StreamOptions): AssistantMessageEventStream;
    streamSimple(
      model: Model,
      context: unknown,
      options?: StreamOptions,
    ): AssistantMessageEventStream;
  }

  export interface CreateProviderOptions {
    id: string;
    name?: string;
    baseUrl?: string;
    auth: ProviderAuth;
    models: readonly Model[];
    api: ApiStreams | Partial<Record<string, ApiStreams>>;
  }

  export function createProvider(options: CreateProviderOptions): Provider;
  export function createAssistantMessageEventStream(): AssistantMessageEventStream;
  export function openAICompletionsApi(): ApiStreams;
  export function anthropicMessagesApi(): ApiStreams;
  export function googleGenerativeAIApi(): ApiStreams;
}
