import { describe, expect, it } from "vitest";
import type { ModelFileState } from "./protocol.js";
import {
  branchModel,
  registerKobeModels,
  type ExtensionApiLike,
  type InputContextLike,
} from "./register.js";

/**
 * KOBE-279: the run's model is recorded on the branch it extends. Pi restarted on a branch
 * point knows only the run's model (the model file), so it cannot restore the branch's and
 * starts on the run's without a `model_change`; the extension compares the run's model with the
 * branch's, not only with Pi's selection, and selects it again so Pi records the switch.
 */
const state: ModelFileState = {
  v: 1,
  gateway_url: "http://gw",
  model: { gateway_model: "anthropic/claude-fake", api: "anthropic-messages" },
  token: "token-one-".padEnd(40, "1"),
  run_id: null,
};
const RUN_MODEL = { provider: "kobe", id: "anthropic/claude-fake" };

const modelChange = (modelId: string) => ({ type: "model_change", provider: "kobe", modelId });
const answer = (model: string) => ({
  type: "message",
  message: { role: "assistant", provider: "kobe", model },
});
const user = { type: "message", message: { role: "user", content: "hi" } };
const marker = { type: "custom", customType: "kobe.branch" };

describe("branchModel", () => {
  it("is the latest model_change or answer on the branch, as Pi resumes it", () => {
    expect(branchModel([modelChange("a/one"), user])).toEqual({
      provider: "kobe",
      modelId: "a/one",
    });
    expect(branchModel([modelChange("a/one"), user, answer("b/two"), marker])).toEqual({
      provider: "kobe",
      modelId: "b/two",
    });
    expect(branchModel([answer("b/two"), modelChange("a/one"), marker])).toEqual({
      provider: "kobe",
      modelId: "a/one",
    });
    expect(branchModel([user, marker])).toBeUndefined();
    expect(branchModel([{ type: "message", message: null }, 7, null])).toBeUndefined();
  });
});

async function setup() {
  type Handler = (e: unknown, ctx: InputContextLike) => Promise<void>;
  const handlers = new Map<string, Handler>();
  const selected: unknown[] = [];
  const api = {
    registerProvider: () => undefined,
    on: (event: string, h: Handler) => void handlers.set(event, h),
    setModel: async (m: unknown) => {
      selected.push(m);
      return true;
    },
  } as unknown as ExtensionApiLike;
  await registerKobeModels(api, {
    env: { KOBE_MODEL_FILE: "/x/model.json" },
    readState: async () => state,
    pi: {
      createProvider: (o) => o as never,
      createAssistantMessageEventStream: () => ({}) as never,
    },
    apis: {} as never,
    warn: () => undefined,
  });
  const fire = (branch: readonly unknown[]) =>
    handlers.get("input")?.({}, { model: RUN_MODEL, sessionManager: { getBranch: () => branch } });
  return { fire, selected };
}

describe("kobe-models input hook (KOBE-279)", () => {
  it("selects the run's model again when Pi is on it but the branch is on another", async () => {
    const { fire, selected } = await setup();
    await fire([modelChange("openai/gpt-fake"), user, answer("openai/gpt-fake"), marker]);
    expect(selected).toEqual([expect.objectContaining({ provider: "kobe", id: RUN_MODEL.id })]);
  });

  it("records nothing when the branch is on the run's model already", async () => {
    const { fire, selected } = await setup();
    await fire([modelChange("openai/gpt-fake"), user, answer(RUN_MODEL.id), marker]);
    await fire([modelChange(RUN_MODEL.id), user]);
    await fire([]);
    expect(selected).toEqual([]);
  });
});
