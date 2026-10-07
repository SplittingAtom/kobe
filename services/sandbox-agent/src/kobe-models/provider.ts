import type {
  ApiStreams,
  AssistantMessage,
  AssistantMessageEvent,
  AssistantMessageEventStream,
  CreateProviderOptions,
  Model,
  Provider,
  ProviderHeaders,
  ProviderResponse,
  StreamOptions,
} from "@earendil-works/pi-ai";
import {
  classifyFailure,
  isTransient,
  isUnauthorized,
  kobeErrorMessage,
  runErrorCode,
  type Failure,
} from "./errors.js";
import {
  KOBE_MODEL_ERROR_PREFIX,
  KOBE_PROVIDER_ID,
  RUN_TOKEN_HEADER,
  gatewayBaseUrl,
  type ModelFileModel,
  type ModelFileState,
} from "./protocol.js";

/**
 * The `kobe` Pi provider (KOBE-41): one model, the run's, served by the Kobe model gateway through
 * Pi's own API adapters. Per request it reads the model file for the current session token (the
 * API key) and the active run (`x-kobe-run-id`), so a rotated token is picked up by the next
 * request without restarting Pi or cutting a stream.
 *
 * Gateway refusals are handled here, where the HTTP status and Retry-After are visible:
 * - 429/502/503/504 and the shim's transient codes: wait Retry-After (capped) or back off, within
 *   {@link RETRY_BUDGET_MS}; only before anything was streamed.
 * - 401: re-read the file once (the agent may just have rotated the token) and retry at once.
 * - anything else, or a retry budget spent: the stream ends with an error whose message names a
 *   Kobe run error code (`kobe.model_error:<code>`), which the server turns into `run.failed`.
 */
export const RETRY_BUDGET_MS = 60_000;
export const RETRY_BASE_MS = 1_000;
const MAX_ATTEMPTS = 8;
const RUN_ID_HEADER = "x-kobe-run-id";
const ABORTED_MESSAGE = "Request was aborted";
const NO_FAILURE: Failure = { status: undefined, code: undefined, retryAfterMs: undefined };

/** pi-ai's provider helpers (Pi's copy at runtime; stand-ins in unit tests). */
export interface PiAiLike {
  createProvider(options: CreateProviderOptions): Provider;
  createAssistantMessageEventStream(): AssistantMessageEventStream;
}

export interface KobeProviderDeps {
  readonly pi: PiAiLike;
  /** The model file as read when this provider was built (its gateway URL and model). */
  readonly initial: ModelFileState;
  readonly readState: () => Promise<ModelFileState>;
  /**
   * The gateway token of `runId` (KOBE-118), held in this process's memory only; undefined when
   * the run has none (older server or agent): calls then carry only the advisory run id.
   */
  readonly runToken?: (runId: string) => string | undefined;
  readonly apis: Readonly<Record<ModelFileModel["api"], ApiStreams>>;
  readonly sleep?: (ms: number, signal: AbortSignal | undefined) => Promise<void>;
  readonly now?: () => number;
  readonly warn?: (message: string) => void;
}

function defaultSleep(ms: number, signal: AbortSignal | undefined): Promise<void> {
  if (signal?.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(done, ms);
    signal?.addEventListener("abort", done, { once: true });
    function done() {
      clearTimeout(timer);
      signal?.removeEventListener("abort", done);
      resolve();
    }
  });
}

/** Pi's catalog entry for a run's model. */
export function kobeModel(gatewayUrl: string, model: ModelFileModel): Model {
  const { api, gateway_model } = model;
  return {
    id: gateway_model,
    name: gateway_model,
    api,
    provider: KOBE_PROVIDER_ID,
    baseUrl: gatewayBaseUrl(gatewayUrl, api),
    // Thinking is opted into per run (`thinking_level`); OpenAI-compatible endpoints (vLLM,
    // Ollama, chat completions) reject reasoning parameters they do not know, so only the
    // native vendor APIs advertise it. Catalog capability flags are a KOBE-44 follow-up.
    reasoning: api !== "openai-completions",
    input: ["text", "image"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 128_000,
    maxTokens: 16_384,
  };
}

function withRunHeader(
  headers: ProviderHeaders | undefined,
  runId: string | null,
  runToken: string | undefined,
): ProviderHeaders {
  const base: ProviderHeaders = Object.fromEntries(
    Object.entries(headers ?? {}).filter(
      ([name]) => ![RUN_ID_HEADER, RUN_TOKEN_HEADER].includes(name.toLowerCase()),
    ),
  );
  const withId = runId === null ? base : { ...base, [RUN_ID_HEADER]: runId };
  return runToken === undefined ? withId : { ...withId, [RUN_TOKEN_HEADER]: runToken };
}

function errorResult(
  message: AssistantMessage,
  errorMessage: string,
  stopReason: "error" | "aborted" = "error",
): AssistantMessage {
  return { ...message, stopReason, errorMessage };
}

export function createKobeProvider(deps: KobeProviderDeps): Provider {
  const sleep = deps.sleep ?? defaultSleep;
  const now = deps.now ?? Date.now;
  const runTokenOf = (state: ModelFileState): string | undefined =>
    state.run_id === null ? undefined : deps.runToken?.(state.run_id);
  const base = deps.pi.createProvider({
    id: KOBE_PROVIDER_ID,
    name: "Kobe model gateway",
    baseUrl: deps.initial.gateway_url,
    auth: {
      apiKey: {
        name: "Kobe session token",
        check: async () => ({ type: "api_key", source: "kobe-sandbox-agent" }),
        resolve: async () => {
          const state = await deps.readState();
          return {
            auth: {
              apiKey: state.token,
              headers: withRunHeader(undefined, state.run_id, runTokenOf(state)),
            },
            source: "kobe-sandbox-agent",
          };
        },
      },
    },
    models:
      deps.initial.model === null ? [] : [kobeModel(deps.initial.gateway_url, deps.initial.model)],
    api: deps.apis,
  });

  /** Delay before the next attempt, or undefined when the failure is final. */
  function retryDelay(
    failure: Failure,
    attempt: number,
    startedAt: number,
    reauthed: boolean,
  ): { readonly delayMs: number; readonly reauth: boolean } | undefined {
    if (attempt >= MAX_ATTEMPTS) return undefined;
    if (isUnauthorized(failure)) return reauthed ? undefined : { delayMs: 0, reauth: true };
    if (!isTransient(failure)) return undefined;
    const delayMs = failure.retryAfterMs ?? Math.min(RETRY_BASE_MS * 2 ** (attempt - 1), 16_000);
    return now() + delayMs - startedAt > RETRY_BUDGET_MS ? undefined : { delayMs, reauth: false };
  }

  function guarded(
    run: (model: Model, context: unknown, options?: StreamOptions) => AssistantMessageEventStream,
  ) {
    return (
      model: Model,
      context: unknown,
      options?: StreamOptions,
    ): AssistantMessageEventStream => {
      const out = deps.pi.createAssistantMessageEventStream();
      // Whatever happens, the stream ends: a hung stream would stall the run for good.
      pump(run, model, context, options, out).catch((error: unknown) => {
        deps.warn?.(`kobe-models: model request failed: ${(error as Error).message}`);
        fail(out, model, kobeErrorMessage("model_error", NO_FAILURE, 1));
      });
      return out;
    };
  }

  async function pump(
    run: (model: Model, context: unknown, options?: StreamOptions) => AssistantMessageEventStream,
    model: Model,
    context: unknown,
    options: StreamOptions | undefined,
    out: AssistantMessageEventStream,
  ): Promise<void> {
    const startedAt = now();
    let reauthed = false;
    for (let attempt = 1; ; attempt++) {
      let state: ModelFileState;
      try {
        state = await deps.readState();
      } catch (error) {
        deps.warn?.(`kobe-models: ${(error as Error).message}`);
        fail(out, model, kobeErrorMessage("model_error", NO_FAILURE, attempt));
        return;
      }
      let response: ProviderResponse | undefined;
      const inner = run(model, context, {
        ...options,
        // The adapters' own SDK retries would hide the status this loop decides on.
        maxRetries: 0,
        apiKey: state.token,
        headers: withRunHeader(options?.headers, state.run_id, runTokenOf(state)),
        onResponse: async (r, m) => {
          response = r;
          await options?.onResponse?.(r, m);
        },
      });
      let forwarded = 0;
      let errored: AssistantMessage | undefined;
      let reason = "error";
      for await (const event of inner) {
        if (event.type === "error") {
          errored = (event as { error: AssistantMessage }).error;
          reason = (event as { reason: string }).reason;
          break;
        }
        forwarded++;
        out.push(event);
      }
      if (errored === undefined) {
        out.end(await inner.result());
        return;
      }
      // Upstream error text never reaches Pi's entries: every error message here is fixed text.
      if (reason === "aborted" || options?.signal?.aborted) {
        const aborted = errorResult(errored, ABORTED_MESSAGE, "aborted");
        out.push({ type: "error", reason: "aborted", error: aborted });
        out.end(aborted);
        return;
      }
      if (forwarded > 0) {
        // Something was streamed: never retried (the model may have acted); a fixed error.
        fail(out, errored, `${KOBE_MODEL_ERROR_PREFIX}model_error: the stream ended with an error`);
        return;
      }
      const failure = classifyFailure(errored.errorMessage, response);
      const next = retryDelay(failure, attempt, startedAt, reauthed);
      if (next === undefined) {
        fail(out, errored, kobeErrorMessage(runErrorCode(failure), failure, attempt));
        return;
      }
      if (next.reauth) reauthed = true;
      deps.warn?.(
        `kobe-models: model request failed (${failure.status ?? "no status"} ${failure.code ?? ""}); retrying in ${next.delayMs} ms`,
      );
      await sleep(next.delayMs, options?.signal);
      if (options?.signal?.aborted) {
        const aborted = errorResult(errored, ABORTED_MESSAGE, "aborted");
        out.push({ type: "error", reason: "aborted", error: aborted });
        out.end(aborted);
        return;
      }
    }
  }

  function fail(
    out: AssistantMessageEventStream,
    from: Model | AssistantMessage,
    errorMessage: string,
  ) {
    const message: AssistantMessage =
      "role" in from
        ? errorResult(from, errorMessage)
        : {
            role: "assistant",
            content: [],
            api: from.api,
            provider: from.provider,
            model: from.id,
            usage: {
              input: 0,
              output: 0,
              cacheRead: 0,
              cacheWrite: 0,
              totalTokens: 0,
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
            },
            stopReason: "error",
            errorMessage,
            timestamp: now(),
          };
    const event: AssistantMessageEvent = { type: "error", reason: "error", error: message };
    out.push(event);
    out.end(message);
  }

  return {
    ...base,
    stream: guarded((model, context, options) => base.stream(model, context, options)),
    streamSimple: guarded((model, context, options) => base.streamSimple(model, context, options)),
  };
}
