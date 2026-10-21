import { describe, expect, it } from "vitest";
import type {
  ApiStreams,
  AssistantMessage,
  AssistantMessageEvent,
  AssistantMessageEventStream,
  CreateProviderOptions,
  Model,
  Provider,
  StreamOptions,
} from "@earendil-works/pi-ai";
import {
  DEFAULT_CONTEXT_WINDOW,
  DEFAULT_MAX_OUTPUT_TOKENS,
  RETRY_BUDGET_MS,
  createKobeProvider,
  kobeModel,
} from "./provider.js";
import { KOBE_MODEL_ERROR_PREFIX, type ModelFileModel, type ModelFileState } from "./protocol.js";

/**
 * The retry wrapper against a scripted API adapter (pi-ai is Pi's at runtime; here a stand-in with
 * the same stream contract). Each script step is an HTTP outcome the fake "adapter" plays.
 */
type Step =
  { status: number; code?: string; retryAfter?: string } | { text: string } | { aborted: true };

const RUN = "3e4f5a6b-7c8d-4e9f-8a1b-2c3d4e5f6072";
const state = (over: Partial<ModelFileState> = {}): ModelFileState => ({
  v: 1,
  gateway_url: "http://gw",
  model: { gateway_model: "openai/gpt-fake", api: "openai-completions" },
  token: "token-one-".padEnd(40, "1"),
  run_id: RUN,
  ...over,
});

/** pi-ai's EventStream contract: events are consumed as they are pushed; `end` resolves `result`. */
class FakeStream implements AssistantMessageEventStream {
  readonly #queue: AssistantMessageEvent[] = [];
  #wake: (() => void) | undefined;
  #ended = false;
  #result: AssistantMessage | undefined;
  #resolve: ((m: AssistantMessage) => void) | undefined;
  readonly #done = new Promise<AssistantMessage>((r) => (this.#resolve = r));
  push(event: AssistantMessageEvent) {
    this.#queue.push(event);
    this.#wake?.();
  }
  end(result?: AssistantMessage) {
    this.#ended = true;
    this.#result = result;
    if (result) this.#resolve?.(result);
    this.#wake?.();
  }
  async *[Symbol.asyncIterator]() {
    for (;;) {
      const next = this.#queue.shift();
      if (next) {
        yield next;
        continue;
      }
      if (this.#ended) return;
      await new Promise<void>((r) => (this.#wake = r));
      this.#wake = undefined;
    }
  }
  result() {
    return this.#result ? Promise.resolve(this.#result) : this.#done;
  }
}

/** `createProvider` as kobe-models uses it: models plus dispatch by `model.api`. */
const pi = {
  createProvider(options: CreateProviderOptions): Provider {
    const apis = options.api as Partial<Record<string, ApiStreams>>;
    const dispatch = (model: Model, context: unknown, o?: StreamOptions) => {
      const api = apis[model.api];
      if (!api) throw new Error(`no api ${model.api}`);
      return api.stream(model, context, o);
    };
    return {
      id: options.id,
      name: options.name ?? options.id,
      auth: options.auth,
      getModels: () => options.models,
      stream: dispatch,
      streamSimple: dispatch,
    };
  },
  createAssistantMessageEventStream: () => new FakeStream(),
};

const message = (model: Model, extra: Partial<AssistantMessage>): AssistantMessage => ({
  role: "assistant",
  content: [],
  api: model.api,
  provider: model.provider,
  model: model.id,
  usage: {},
  stopReason: "stop",
  timestamp: 1,
  ...extra,
});

function fakeApi(script: Step[], calls: StreamOptions[]): ApiStreams {
  const stream = (model: Model, _ctx: unknown, options?: StreamOptions) => {
    calls.push(options ?? {});
    const out = new FakeStream();
    const step = script.shift() ?? { status: 500 };
    void (async () => {
      if ("text" in step) {
        await options?.onResponse?.({ status: 200, headers: {} }, model);
        out.push({ type: "text_delta", delta: step.text } as AssistantMessageEvent);
        const done = message(model, { content: [{ type: "text", text: step.text }] });
        out.push({ type: "done", reason: "stop", message: done });
        out.end(done);
        return;
      }
      if ("aborted" in step) {
        const err = message(model, { stopReason: "aborted", errorMessage: "Request was aborted" });
        out.push({ type: "error", reason: "aborted", error: err });
        out.end(err);
        return;
      }
      await options?.onResponse?.(
        { status: step.status, headers: step.retryAfter ? { "retry-after": step.retryAfter } : {} },
        model,
      );
      const body = JSON.stringify({ message: "m", type: step.code ?? "x", code: step.code ?? "x" });
      const err = message(model, { stopReason: "error", errorMessage: `${step.status}: ${body}` });
      out.push({ type: "error", reason: "error", error: err });
      out.end(err);
    })();
    return out;
  };
  return { api: "openai-completions", stream, streamSimple: stream };
}

async function collect(stream: AssistantMessageEventStream) {
  const events: AssistantMessageEvent[] = [];
  for await (const e of stream) events.push(e);
  return { events, result: await stream.result() };
}

function setup(
  script: Step[],
  states: ModelFileState[] = [state()],
  runToken?: (runId: string) => string | undefined,
  onCallEnded?: Parameters<typeof createKobeProvider>[0]["onCallEnded"],
) {
  const calls: StreamOptions[] = [];
  const sleeps: number[] = [];
  let clock = 0;
  const provider = createKobeProvider({
    pi,
    initial: states[0] as ModelFileState,
    ...(runToken ? { runToken } : {}),
    ...(onCallEnded ? { onCallEnded } : {}),
    readState: async () =>
      states.length > 1 ? (states.shift() as ModelFileState) : (states[0] as ModelFileState),
    apis: {
      "openai-completions": fakeApi(script, calls),
      "anthropic-messages": fakeApi([], calls),
      "google-generative-ai": fakeApi([], calls),
    },
    sleep: async (ms) => {
      sleeps.push(ms);
      clock += ms;
    },
    now: () => clock,
  });
  const model = provider.getModels()[0] as Model;
  return { provider, model, calls, sleeps };
}

describe("kobe provider", () => {
  it("tells the context capture once per call, after it ended, with the context it was given (KOBE-470)", async () => {
    const ended: { context: unknown; result: AssistantMessage; options: unknown }[] = [];
    const { provider, model } = setup(
      [{ status: 503 }, { text: "hi" }],
      [state()],
      undefined,
      (_model, context, options, result) => ended.push({ context, result, options }),
    );
    const context = { messages: [{ role: "user", content: "hello" }] };
    const { result } = await collect(provider.streamSimple(model, context, { maxTokens: 9 }));
    await new Promise((r) => setTimeout(r, 0));
    expect(ended).toHaveLength(1);
    expect(ended[0]?.context).toBe(context);
    expect(ended[0]?.result).toBe(result);
    expect(ended[0]?.options).toMatchObject({ maxTokens: 9 });
  });

  it("describes the run's model under the kobe provider with the gateway base URL", () => {
    const model = kobeModel("http://gw", state().model as ModelFileModel);
    expect(model).toMatchObject({
      id: "openai/gpt-fake",
      provider: "kobe",
      api: "openai-completions",
      baseUrl: "http://gw/v1",
      reasoning: false,
    });
    expect(
      kobeModel("http://gw", { gateway_model: "anthropic/c", api: "anthropic-messages" }),
    ).toMatchObject({ baseUrl: "http://gw/anthropic", reasoning: true });
    expect(setup([], [state({ model: null })]).provider.getModels()).toEqual([]);
    const { provider } = setup([]);
    expect(provider.getModels().map((m) => m.id)).toEqual(["openai/gpt-fake"]);
  });

  it("takes the output limit and context window from the model file, else the old defaults (KOBE-259)", () => {
    const base = { gateway_model: "ollama/glm-5.3", api: "openai-completions" } as const;
    expect(
      kobeModel("http://gw", { ...base, max_output_tokens: 65_536, context_window: 200_000 }),
    ).toMatchObject({ maxTokens: 65_536, contextWindow: 200_000 });
    // An older server sends no limits: what every model had before.
    expect(kobeModel("http://gw", base)).toMatchObject({
      maxTokens: DEFAULT_MAX_OUTPUT_TOKENS,
      contextWindow: DEFAULT_CONTEXT_WINDOW,
    });
    expect([DEFAULT_MAX_OUTPUT_TOKENS, DEFAULT_CONTEXT_WINDOW]).toEqual([16_384, 128_000]);
  });

  it("sends the current token as the API key and the active run as x-kobe-run-id", async () => {
    const { provider, model, calls } = setup([{ text: "hi" }]);
    const { events, result } = await collect(
      provider.stream(model, {}, { headers: { "x-other": "1" } }),
    );
    expect(result.stopReason).toBe("stop");
    expect(events.map((e) => e.type)).toEqual(["text_delta", "done"]);
    expect(calls[0]).toMatchObject({
      apiKey: "token-one-".padEnd(40, "1"),
      maxRetries: 0,
      headers: { "x-other": "1", "x-kobe-run-id": RUN },
    });
  });

  it("sends the run's token as x-kobe-run-token (KOBE-118) and overrides one in the options", async () => {
    const { provider, model, calls } = setup([{ text: "a" }, { text: "b" }], [state()], (runId) =>
      runId === RUN ? "krt1.tok.mac" : undefined,
    );
    await collect(provider.stream(model, {}, { headers: { "X-Kobe-Run-Token": "forged" } }));
    expect(calls[0]?.headers).toEqual({ "x-kobe-run-id": RUN, "x-kobe-run-token": "krt1.tok.mac" });
    // Another run's token is never sent for this run, and none without a run.
    const other = setup([{ text: "c" }], [state({ run_id: null })], () => "krt1.tok.mac");
    await collect(other.provider.stream(other.model, {}));
    expect(other.calls[0]?.headers).not.toHaveProperty("x-kobe-run-token");
    const none = setup([{ text: "d" }], [state()], () => undefined);
    await collect(none.provider.stream(none.model, {}));
    expect(none.calls[0]?.headers).not.toHaveProperty("x-kobe-run-token");
  });

  it("sends the run's span as traceparent (KOBE-274), never a forged one or one without a run", async () => {
    const tp = "00-3e4f5a6b7c8d4e9f8a1b2c3d4e5f6072-1111111111111111-01";
    const { provider, model, calls } = setup([{ text: "a" }], [state({ traceparent: tp })]);
    await collect(provider.stream(model, {}, { headers: { traceparent: "00-forged" } }));
    expect(calls[0]?.headers).toMatchObject({ traceparent: tp });
    const off = setup([{ text: "b" }], [state()]);
    await collect(off.provider.stream(off.model, {}, { headers: { Traceparent: "00-forged" } }));
    expect(off.calls[0]?.headers).not.toHaveProperty("traceparent");
    expect(off.calls[0]?.headers).not.toHaveProperty("Traceparent");
    const idle = setup([{ text: "c" }], [state({ run_id: null, traceparent: tp })]);
    await collect(idle.provider.stream(idle.model, {}));
    expect(idle.calls[0]?.headers).not.toHaveProperty("traceparent");
  });

  it("reads the file per request: a rotated token and a cleared run id reach the next call", async () => {
    const states = [state(), state({ token: "token-two-".padEnd(40, "2"), run_id: null })];
    const { provider, model, calls } = setup([{ text: "a" }, { text: "b" }], states);
    await collect(provider.stream(model, {}));
    await collect(provider.stream(model, {}));
    expect(calls[1]).toMatchObject({ apiKey: "token-two-".padEnd(40, "2") });
    expect(calls[1]?.headers).not.toHaveProperty("x-kobe-run-id");
  });

  it("waits Retry-After on 503 model_access_pending and then succeeds, transparently", async () => {
    const { provider, model, calls, sleeps } = setup([
      { status: 503, code: "model_access_pending", retryAfter: "2" },
      { status: 429, code: "too_many_concurrent_calls", retryAfter: "1" },
      { text: "ok" },
    ]);
    const { events, result } = await collect(provider.stream(model, {}));
    expect(sleeps).toEqual([2000, 1000]);
    expect(calls).toHaveLength(3);
    expect(result.stopReason).toBe("stop");
    expect(events.filter((e) => e.type === "error")).toEqual([]);
  });

  it("backs off without Retry-After and gives up within the budget as model_unavailable", async () => {
    const { provider, model, sleeps } = setup(
      Array.from({ length: 12 }, () => ({ status: 503, code: "model_gateway_resyncing" })),
    );
    const { events, result } = await collect(provider.stream(model, {}));
    expect(sleeps.reduce((a, b) => a + b, 0)).toBeLessThanOrEqual(RETRY_BUDGET_MS);
    expect(sleeps[0]).toBe(1000);
    expect(result.stopReason).toBe("error");
    expect(result.errorMessage).toMatch(
      new RegExp(`^${KOBE_MODEL_ERROR_PREFIX}model_unavailable: `),
    );
    expect(events.at(-1)).toMatchObject({ type: "error", reason: "error" });
  });

  it("fails fast on 403 model_not_enabled with the code the server shows", async () => {
    const { provider, model, calls, sleeps } = setup([{ status: 403, code: "model_not_enabled" }]);
    const { result } = await collect(provider.stream(model, {}));
    expect(calls).toHaveLength(1);
    expect(sleeps).toEqual([]);
    expect(result.errorMessage).toBe(
      `${KOBE_MODEL_ERROR_PREFIX}model_not_enabled: gave up after 1 attempt`,
    );
  });

  it("re-reads the token once on 401 (a rotation in flight), then reports a revoked session", async () => {
    const fresh = state({ token: "token-two-".padEnd(40, "2") });
    const { provider, model, calls } = setup(
      [{ status: 401, code: "invalid_session_token" }, { text: "ok" }],
      [state(), fresh],
    );
    const { result } = await collect(provider.stream(model, {}));
    expect(result.stopReason).toBe("stop");
    expect(calls.map((c) => c.apiKey)).toEqual([state().token, fresh.token]);

    const revoked = setup([
      { status: 401, code: "session_revoked" },
      { status: 401, code: "session_revoked" },
    ]);
    const second = await collect(revoked.provider.stream(revoked.model, {}));
    expect(revoked.calls).toHaveLength(2);
    expect(second.result.errorMessage).toMatch(/^kobe\.model_error:model_session_revoked: /);
  });

  it("never retries once something was streamed, and passes aborts through with fixed text", async () => {
    const aborted = setup([{ aborted: true }, { text: "never" }]);
    const { result, events } = await collect(aborted.provider.stream(aborted.model, {}));
    expect(result.stopReason).toBe("aborted");
    expect(result.errorMessage).toBe("Request was aborted");
    expect(events).toHaveLength(1);
    expect(aborted.calls).toHaveLength(1);
  });

  it("replaces an upstream error after streaming began with fixed text (never stored raw)", async () => {
    const calls: StreamOptions[] = [];
    const midStream: ApiStreams = {
      api: "openai-completions",
      stream: (model) => {
        const out = new FakeStream();
        out.push({ type: "text_delta", delta: "partial" } as AssistantMessageEvent);
        const err = message(model, {
          stopReason: "error",
          errorMessage: '503: {"raw":"<upstream text>"}',
        });
        out.push({ type: "error", reason: "error", error: err });
        out.end(err);
        return out;
      },
      streamSimple: () => new FakeStream(),
    };
    const provider = createKobeProvider({
      pi,
      initial: state(),
      readState: async () => state(),
      apis: {
        "openai-completions": midStream,
        "anthropic-messages": fakeApi([], calls),
        "google-generative-ai": fakeApi([], calls),
      },
    });
    const model = provider.getModels()[0] as Model;
    const { result, events } = await collect(provider.stream(model, {}));
    expect(events.map((e) => e.type)).toEqual(["text_delta", "error"]);
    expect(result.errorMessage).toBe(
      `${KOBE_MODEL_ERROR_PREFIX}model_error: the stream ended with an error`,
    );
    expect(JSON.stringify(events)).not.toContain("upstream text");
  });

  it("stops retrying when the run is aborted while waiting", async () => {
    const controller = new AbortController();
    const calls: StreamOptions[] = [];
    const provider = createKobeProvider({
      pi,
      initial: state(),
      readState: async () => state(),
      apis: {
        "openai-completions": fakeApi([{ status: 503, retryAfter: "1" }, { text: "x" }], calls),
        "anthropic-messages": fakeApi([], calls),
        "google-generative-ai": fakeApi([], calls),
      },
      sleep: async () => controller.abort(),
    });
    const model = provider.getModels()[0] as Model;
    const { result } = await collect(provider.stream(model, {}, { signal: controller.signal }));
    expect(result.stopReason).toBe("aborted");
    expect(result.errorMessage).toBe("Request was aborted");
    expect(calls).toHaveLength(1);
  });

  it("reports model_error when the model file cannot be read", async () => {
    const calls: StreamOptions[] = [];
    const provider = createKobeProvider({
      pi,
      initial: state(),
      readState: async () => {
        throw new Error("ENOENT");
      },
      apis: {
        "openai-completions": fakeApi([{ text: "x" }], calls),
        "anthropic-messages": fakeApi([], calls),
        "google-generative-ai": fakeApi([], calls),
      },
    });
    const model = provider.getModels()[0] as Model;
    const { result } = await collect(provider.stream(model, {}));
    expect(calls).toEqual([]);
    expect(result.errorMessage).toMatch(/^kobe\.model_error:model_error: gave up/);
  });

  it("ends the stream with model_error when the adapter itself throws (never a hung run)", async () => {
    const calls: StreamOptions[] = [];
    const throwing: ApiStreams = {
      api: "openai-completions",
      stream: () => {
        throw new Error("adapter exploded");
      },
      streamSimple: () => {
        throw new Error("adapter exploded");
      },
    };
    const provider = createKobeProvider({
      pi,
      initial: state(),
      readState: async () => state(),
      apis: {
        "openai-completions": throwing,
        "anthropic-messages": fakeApi([], calls),
        "google-generative-ai": fakeApi([], calls),
      },
    });
    const model = provider.getModels()[0] as Model;
    const { result, events } = await collect(provider.stream(model, {}));
    expect(result.stopReason).toBe("error");
    expect(result.errorMessage).toMatch(/^kobe\.model_error:model_error: /);
    expect(events.at(-1)?.type).toBe("error");
  });
});
