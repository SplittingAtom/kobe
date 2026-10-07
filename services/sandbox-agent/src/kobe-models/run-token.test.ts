import { describe, expect, it, vi } from "vitest";
import { RUN_TOKEN_HEADER as PROTOCOL_HEADER } from "@kobe/protocol";
import { registerKobeModels, type ExtensionApiLike, type InputContextLike } from "./register.js";
import { RUN_TOKEN_HEADER, RUN_TOKEN_UI_TITLE, type ModelFileState } from "./protocol.js";

/** KOBE-118: the extension fetches the run token over Pi's RPC channel, once per run. */
const RUN = "3e4f5a6b-7c8d-4e9f-8a1b-2c3d4e5f6072";
const RUN_B = "4e4f5a6b-7c8d-4e9f-8a1b-2c3d4e5f6073";
const state = (run_id: string | null): ModelFileState => ({
  v: 1,
  gateway_url: "http://gw",
  model: { gateway_model: "openai/gpt-fake", api: "openai-completions" },
  token: "token-one-".padEnd(40, "1"),
  run_id,
});

it("pins the header name to the protocol's", () => {
  expect(RUN_TOKEN_HEADER).toBe(PROTOCOL_HEADER);
});

async function setup(states: () => ModelFileState) {
  const handlers: ((e: unknown, ctx: InputContextLike) => Promise<void>)[] = [];
  const registered: {
    auth: { apiKey: { resolve: () => Promise<{ auth: { headers: object } }> } };
  }[] = [];
  const api = {
    registerProvider: (p: unknown) => void registered.push(p as (typeof registered)[number]),
    on: (_: "input", h: (typeof handlers)[number]) => void handlers.push(h),
    setModel: async () => true,
  } as unknown as ExtensionApiLike;
  await registerKobeModels(api, {
    env: { KOBE_MODEL_FILE: "/x/model.json" },
    readState: async () => states(),
    pi: {
      createProvider: (o) => o as never,
      createAssistantMessageEventStream: () => ({}) as never,
    },
    apis: {} as never,
    warn: () => undefined,
  });
  const headers = async () =>
    (await registered.at(-1)?.auth.apiKey.resolve())?.auth.headers as Record<string, string>;
  return { fire: (ctx: InputContextLike) => handlers[0]?.({}, ctx), headers };
}

describe("run token in kobe-models", () => {
  it("asks once per run, keeps the token in memory, and sends it as a header", async () => {
    let current = state(RUN);
    const asked: string[] = [];
    const ctx: InputContextLike = {
      ui: {
        input: async (title) => {
          asked.push(title);
          return `krt1.${current.run_id}.mac`;
        },
      },
    };
    const { fire, headers } = await setup(() => current);
    await fire(ctx);
    await fire(ctx); // steer / second prompt of the same run: no second request
    expect(asked).toEqual([RUN_TOKEN_UI_TITLE]);
    expect(await headers()).toMatchObject({ "x-kobe-run-token": `krt1.${RUN}.mac` });
    current = state(RUN_B);
    await fire(ctx);
    expect(asked).toHaveLength(2);
    expect(await headers()).toMatchObject({ "x-kobe-run-token": `krt1.${RUN_B}.mac` });
    current = state(null);
    await fire(ctx);
    expect(await headers()).not.toHaveProperty("x-kobe-run-token");
  });

  it("sends no token when Pi cannot ask, the agent cancels, or the dialog fails", async () => {
    const current = state(RUN);
    const { fire, headers } = await setup(() => current);
    await fire({});
    expect(await headers()).not.toHaveProperty("x-kobe-run-token");
    await fire({ ui: { input: async () => undefined } });
    expect(await headers()).not.toHaveProperty("x-kobe-run-token");
    await fire({
      ui: {
        input: async () => {
          throw new Error("no rpc");
        },
      },
    });
    expect(await headers()).not.toHaveProperty("x-kobe-run-token");
  });

  it("does not hold the prompt on an agent that never answers", async () => {
    vi.useFakeTimers();
    try {
      const { fire, headers } = await setup(() => state(RUN));
      const fired = fire({ ui: { input: () => new Promise<string | undefined>(() => undefined) } });
      await vi.advanceTimersByTimeAsync(5_000);
      await fired;
      expect(await headers()).not.toHaveProperty("x-kobe-run-token");
    } finally {
      vi.useRealTimers();
    }
  });
});
