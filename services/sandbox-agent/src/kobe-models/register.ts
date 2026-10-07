import type { Model, Provider } from "@earendil-works/pi-ai";
import { KOBE_PROVIDER_ID, RUN_TOKEN_UI_TITLE, type ModelFileState } from "./protocol.js";
import { createKobeProvider, kobeModel, type KobeProviderDeps, type PiAiLike } from "./provider.js";
import { takeModelFilePath } from "./state-file.js";

/** The registration logic of kobe-models, apart from `index.ts` so tests can load it without Pi. */
export interface InputContextLike {
  readonly model?: { readonly provider: string; readonly id: string } | undefined;
  /** Pi's extension UI; in RPC mode a dialog is answered by the agent (the run token's channel). */
  readonly ui?: {
    readonly input?: (title: string, placeholder?: string) => Promise<string | undefined>;
  };
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
/** Taken from the environment once per Pi process; a reload registers the same file again. */
let modelFile: string | undefined;

export async function registerKobeModels(
  api: ExtensionApiLike,
  deps: KobeModelsDeps,
): Promise<void> {
  const file = (modelFile ??= takeModelFilePath(deps.env));
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
      runToken: (runId) => (held?.runId === runId ? held.token : undefined),
      apis: deps.apis,
      warn: deps.warn,
    });
  /** The active run's gateway token, fetched once per run over Pi's RPC channel; memory only. */
  let held: { readonly runId: string; readonly token: string } | undefined;
  const refreshRunToken = async (state: ModelFileState, ctx: InputContextLike): Promise<void> => {
    if (state.run_id === null) {
      held = undefined;
      return;
    }
    if (held?.runId === state.run_id || ctx.ui?.input === undefined) return;
    held = undefined;
    try {
      const token = await ctx.ui.input(RUN_TOKEN_UI_TITLE);
      if (typeof token === "string" && token.length > 0) held = { runId: state.run_id, token };
    } catch (error) {
      deps.warn(`kobe-models: run token unavailable: ${(error as Error).message}`);
    }
  };
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
    await refreshRunToken(state, ctx);
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
