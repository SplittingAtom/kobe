import type { Model, Provider } from "@earendil-works/pi-ai";
import {
  KOBE_PROVIDER_ID,
  RUN_TOKEN_UI_TITLE,
  type ModelFileModel,
  type ModelFileState,
} from "./protocol.js";
import { createKobeProvider, kobeModel, type KobeProviderDeps, type PiAiLike } from "./provider.js";
import { takeModelFilePath } from "./state-file.js";

const RUN_TOKEN_WAIT_MS = 5_000;

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T | undefined> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => resolve(undefined), ms);
    timer.unref();
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error instanceof Error ? error : new Error(String(error)));
      },
    );
  });
}

function sameModelLimits(a: ModelFileModel, b: ModelFileModel): boolean {
  return a.max_output_tokens === b.max_output_tokens && a.context_window === b.context_window;
}

/** The registration logic of kobe-models, apart from `index.ts` so tests can load it without Pi. */
export interface InputContextLike {
  readonly model?: { readonly provider: string; readonly id: string } | undefined;
  /** Pi's extension UI; in RPC mode a dialog is answered by the agent (the run token's channel). */
  readonly ui?: {
    readonly input?: (title: string, placeholder?: string) => Promise<string | undefined>;
  };
  /** Pi's session (read-only): the branch the prompt extends, from the root to the leaf. */
  readonly sessionManager?: { readonly getBranch: () => readonly unknown[] };
}

/** A model as a session records it (`model_change`, or an answer's `provider` and `model`). */
export interface RecordedModel {
  readonly provider: string;
  readonly modelId: string;
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null;

/**
 * The model a session branch is on, the way Pi 1.0.0 restores it on resume (`getBranchSelection`,
 * without virtual models, which Kobe never registers): the latest `model_change` or answer on the
 * branch, whichever is nearer the leaf. Undefined when the branch records none.
 */
export function branchModel(branch: readonly unknown[]): RecordedModel | undefined {
  for (let i = branch.length - 1; i >= 0; i -= 1) {
    const entry = branch[i];
    if (!isRecord(entry)) continue;
    if (entry.type === "model_change") {
      const { provider, modelId } = entry;
      return typeof provider === "string" && typeof modelId === "string"
        ? { provider, modelId }
        : undefined;
    }
    const message = entry.type === "message" ? entry.message : undefined;
    if (isRecord(message) && message.role === "assistant") {
      const { provider, model } = message;
      return typeof provider === "string" && typeof model === "string"
        ? { provider, modelId: model }
        : undefined;
    }
  }
  return undefined;
}

/** The branch is on `gatewayModel` (or records no model, so there is no switch to record). */
function branchIsOn(ctx: InputContextLike, gatewayModel: string): boolean {
  const recorded = branchModel(ctx.sessionManager?.getBranch() ?? []);
  return (
    recorded === undefined ||
    (recorded.provider === KOBE_PROVIDER_ID && recorded.modelId === gatewayModel)
  );
}

/** The slice of Pi's `ExtensionAPI` kobe-models uses (structural, so no Pi package dependency). */
export interface ExtensionApiLike {
  registerProvider(provider: Provider): void;
  on(
    event: "input" | "session_before_compact",
    handler: (event: unknown, ctx: InputContextLike) => Promise<void>,
  ): unknown;
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
      // Never hold the prompt on an agent that does not answer (an older one, or a bare RPC driver).
      const token = await withTimeout(ctx.ui.input(RUN_TOKEN_UI_TITLE), RUN_TOKEN_WAIT_MS);
      if (typeof token === "string" && token.length > 0) held = { runId: state.run_id, token };
    } catch (error) {
      deps.warn(`kobe-models: run token unavailable: ${(error as Error).message}`);
    }
  };
  const readOrWarn = async (): Promise<ModelFileState | undefined> => {
    try {
      return await deps.readState(file);
    } catch (error) {
      deps.warn(`kobe-models: ${(error as Error).message}`);
      return undefined;
    }
  };
  let registered = await deps.readState(file);
  api.registerProvider(build(registered));
  // A compaction (KOBE-213) sends Pi no prompt, so `input` never fires for it: fetch the
  // compaction run's token when Pi starts summarizing (before its first model call). The agent
  // selected the model before sending `compact` (Pi reads it before this hook).
  api.on("session_before_compact", async (_event, ctx) => {
    const state = await readOrWarn();
    if (state !== undefined) await refreshRunToken(state, ctx);
  });
  api.on("input", async (_event, ctx) => {
    const state = await readOrWarn();
    if (state === undefined) return;
    await refreshRunToken(state, ctx);
    const wanted = state.model;
    if (wanted === null) return;
    const selected = ctx.model?.provider === KOBE_PROVIDER_ID ? ctx.model.id : undefined;
    // Limits changed (KOBE-259: an admin edited the catalog) re-select the same model.
    const sameLimits = registered.model !== null && sameModelLimits(registered.model, wanted);
    // KOBE-279: a Pi started on a branch point knows only the run's model (the model file), so it
    // cannot restore the branch's and starts on the run's without recording a switch. Selecting
    // it again records the `model_change` on the branch (after the agent's `kobe.branch` marker,
    // before the prompt: `input` runs first), so the chat shows the change where it happened.
    if (selected === wanted.gateway_model && sameLimits && branchIsOn(ctx, wanted.gateway_model)) {
      return;
    }
    if (registered.model?.gateway_model !== wanted.gateway_model || !sameLimits) {
      api.registerProvider(build(state));
      registered = state;
    }
    if (!(await api.setModel(kobeModel(state.gateway_url, wanted)))) {
      deps.warn(`kobe-models: Pi did not accept model ${wanted.gateway_model}`);
    }
  });
}
