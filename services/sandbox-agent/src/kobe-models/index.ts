import {
  anthropicMessagesApi,
  createAssistantMessageEventStream,
  createProvider,
  googleGenerativeAIApi,
  openAICompletionsApi,
  type Model,
  type Provider,
} from "@earendil-works/pi-ai";
import { KOBE_PROVIDER_ID, type ModelFileState } from "./protocol.js";
import { createKobeProvider, kobeModel, type KobeProviderDeps, type PiAiLike } from "./provider.js";
import { readModelState, takeModelFilePath } from "./state-file.js";

/**
 * kobe-models: the Pi 1.0.x extension that gives Pi the run's model through the Kobe model
 * gateway (spec D30; KOBE-41). kobe-sandbox-agent loads it with `--extension <root-owned path>`
 * (before kobe-policy) into every `pi --mode rpc` it starts with a model, together with
 * `--model kobe/<gateway model>` and the model file (`KOBE_MODEL_FILE`, see protocol.ts).
 *
 * Self-contained by design: node builtins, `@earendil-works/pi-ai` (Pi's own copy, aliased by
 * its extension loader) and files in this directory, because the image ships it on its own
 * (root-owned, read-only, `/opt/kobe/pi-extensions/kobe-models`).
 */
export interface InputContextLike {
  readonly model?: { readonly provider: string; readonly id: string } | undefined;
}

/** The slice of Pi's `ExtensionAPI` kobe-models uses (structural, so no Pi package dependency). */
export interface ExtensionApiLike {
  registerProvider(provider: Provider): void;
  on(event: "input", handler: (event: unknown, ctx: InputContextLike) => Promise<void>): unknown;
  setModel(model: Model): Promise<boolean>;
}

export interface KobeModelsDeps {
  readonly env: Record<string, string | undefined>;
  readonly readState: (file: string) => Promise<ModelFileState>;
  readonly pi: PiAiLike;
  readonly apis: KobeProviderDeps["apis"];
  readonly warn: (message: string) => void;
}

/**
 * Register the `kobe` provider from the model file and keep Pi's selected model in step with it:
 * the agent writes the run's model into the file before every prompt, and Pi runs `input`
 * handlers before it validates the selected model (verified Pi 1.0.0; the same hook the faux
 * model in Kobe's tests relies on), so a model change between runs needs no Pi restart.
 */
export async function registerKobeModels(
  api: ExtensionApiLike,
  deps: KobeModelsDeps,
): Promise<void> {
  const file = takeModelFilePath(deps.env);
  if (file === undefined) {
    // Without a model file there is nothing to register: Pi has no provider and refuses prompts.
    deps.warn("kobe-models: no model file (KOBE_MODEL_FILE); no model registered");
    return;
  }
  const build = (initial: ModelFileState) =>
    createKobeProvider({
      pi: deps.pi,
      initial,
      readState: () => deps.readState(file),
      apis: deps.apis,
      warn: deps.warn,
    });
  let registered = await deps.readState(file);
  api.registerProvider(build(registered));
  api.on("input", async (_event, ctx) => {
    let state: ModelFileState;
    try {
      state = await deps.readState(file);
    } catch (error) {
      deps.warn(`kobe-models: ${(error as Error).message}`);
      return;
    }
    const wanted = state.model;
    if (wanted === null) return;
    const selected = ctx.model?.provider === KOBE_PROVIDER_ID ? ctx.model.id : undefined;
    if (selected === wanted.gateway_model) return;
    if (registered.model?.gateway_model !== wanted.gateway_model) {
      api.registerProvider(build(state));
      registered = state;
    }
    if (!(await api.setModel(kobeModel(state.gateway_url, wanted)))) {
      deps.warn(`kobe-models: Pi did not accept model ${wanted.gateway_model}`);
    }
  });
}

export default function kobeModels(api: ExtensionApiLike): Promise<void> {
  return registerKobeModels(api, {
    env: process.env,
    readState: readModelState,
    pi: { createProvider, createAssistantMessageEventStream },
    apis: {
      "openai-completions": openAICompletionsApi(),
      "anthropic-messages": anthropicMessagesApi(),
      "google-generative-ai": googleGenerativeAIApi(),
    },
    // stderr only: stdout is Pi's RPC stream.
    warn: (message) => process.stderr.write(`${message}\n`),
  });
}
