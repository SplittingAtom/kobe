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
import { RETRY_BUDGET_MS, createKobeProvider, kobeModel } from "./provider.js";
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

function setup(script: Step[], states: ModelFileState[] = [state()]) {
  const calls: StreamOptions[] = [];
  const sleeps: number[] = [];
  let clock = 0;
  const provider = createKobeProvider({
    pi,
    initial: states[0] as ModelFileState,
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
      `${KOBE_MODEL_ERROR_PREFIX}model_not_enabled: model_not_enabled after 1 attempt`,
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

  it("never retries once something was streamed, and passes aborts through", async () => {
    const aborted = setup([{ aborted: true }, { text: "never" }]);
    const { result, events } = await collect(aborted.provider.stream(aborted.model, {}));
    expect(result.stopReason).toBe("aborted");
    expect(events).toHaveLength(1);
    expect(aborted.calls).toHaveLength(1);
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
    expect(result.stopReason).toBe("error");
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
    expect(result.errorMessage).toMatch(/^kobe\.model_error:model_error: no_model_file/);
  });
});
