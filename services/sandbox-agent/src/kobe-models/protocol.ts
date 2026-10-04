/**
 * What kobe-sandbox-agent and the kobe-models Pi extension share (KOBE-41): the model file the
 * agent maintains for each Pi process and the environment variable naming it. Kept here (not in
 * `@kobe/protocol`) because the extension ships on its own and imports only node builtins and its
 * own files; `protocol.test.ts` pins the copies of `@kobe/protocol` constants.
 *
 * The file (`KOBE_MODEL_FILE`, 0600, in the Pi process's private runtime directory) holds the
 * sandbox's current `kobe.model-gateway` session token — the one credential a sandbox is designed
 * to hold (D30: "sandboxes call Bifrost with their session token") — and the active run id. The
 * agent rewrites it atomically on every token rotation and run start/end; the extension reads it
 * for every model request, so a rotated token is used by the next request and never interrupts a
 * streaming call (an HTTP request authenticates once, when it starts).
 */
export const MODEL_FILE_ENV = "KOBE_MODEL_FILE";
export const MODEL_FILE_VERSION = 1;
/** The Pi provider id; models are selected as `kobe/<gateway model>`. */
export const KOBE_PROVIDER_ID = "kobe";

/** Copies of `@kobe/protocol` values (pinned by protocol.test.ts). */
export const PI_MODEL_APIS = [
  "openai-completions",
  "anthropic-messages",
  "google-generative-ai",
] as const;
export type PiModelApi = (typeof PI_MODEL_APIS)[number];
export const KOBE_MODEL_ERROR_PREFIX = "kobe.model_error:";
export const MODEL_RUN_ERROR_CODES = [
  "model_not_enabled",
  "model_session_revoked",
  "model_throttled",
  "model_unavailable",
  "model_not_configured",
  "model_error",
  "model_budget_exhausted",
] as const;
export type ModelRunErrorCode = (typeof MODEL_RUN_ERROR_CODES)[number];

export interface ModelFileModel {
  /** `<gateway provider>/<model>` (the catalog's `gateway_model`). */
  readonly gateway_model: string;
  readonly api: PiModelApi;
}

export interface ModelFileState {
  readonly v: typeof MODEL_FILE_VERSION;
  /** `KOBE_MODEL_GATEWAY_URL` (http(s), no credentials). */
  readonly gateway_url: string;
  /**
   * The run's model, or null before the first run (a Pi started for `get_entries`). Selected by
   * the extension on Pi's `input` hook, so a model change never restarts Pi.
   */
  readonly model: ModelFileModel | null;
  /** The current `kobe.model-gateway` session token. */
  readonly token: string;
  /** The active run on this Pi (sent as `x-kobe-run-id`), or null between runs. */
  readonly run_id: string | null;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const GATEWAY_MODEL = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}\/[A-Za-z0-9][A-Za-z0-9._:/-]{0,190}$/;
const MAX_TOKEN_CHARS = 8192;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Parse the model file; throws with the reason on anything but the exact shape. */
export function parseModelFile(text: string): ModelFileState {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new Error("model file is not JSON");
  }
  if (!isRecord(raw)) throw new Error("model file is not an object");
  if (raw.v !== MODEL_FILE_VERSION) throw new Error("model file version is not supported");
  const gateway = raw.gateway_url;
  if (typeof gateway !== "string" || !/^https?:\/\/[^\s/@]+(?::\d{1,5})?$/.test(gateway)) {
    throw new Error("model file gateway_url is not a plain http(s) origin");
  }
  const model = raw.model;
  if (
    model !== null &&
    (!isRecord(model) ||
      typeof model.gateway_model !== "string" ||
      !GATEWAY_MODEL.test(model.gateway_model) ||
      typeof model.api !== "string" ||
      !(PI_MODEL_APIS as readonly string[]).includes(model.api))
  ) {
    throw new Error("model file model is invalid");
  }
  const token = raw.token;
  if (typeof token !== "string" || token.length < 20 || token.length > MAX_TOKEN_CHARS) {
    throw new Error("model file token is invalid");
  }
  const runId = raw.run_id;
  if (runId !== null && (typeof runId !== "string" || !UUID.test(runId))) {
    throw new Error("model file run_id is invalid");
  }
  return {
    v: MODEL_FILE_VERSION,
    gateway_url: gateway,
    model:
      model === null
        ? null
        : { gateway_model: model.gateway_model as string, api: model.api as PiModelApi },
    token,
    run_id: runId === null ? null : runId.toLowerCase(),
  };
}

/**
 * The model gateway base URL for an API style (docs/ledger/KOBE-40.md "For downstream tickets"):
 * OpenAI-style `/v1`, Anthropic native `/anthropic` (the SDK appends `/v1/messages`), Gemini
 * `/genai/v1beta` (the SDK appends `/models/<model>:streamGenerateContent`).
 */
export function gatewayBaseUrl(gatewayUrl: string, api: PiModelApi): string {
  const origin = gatewayUrl.replace(/\/+$/, "");
  switch (api) {
    case "openai-completions":
      return `${origin}/v1`;
    case "anthropic-messages":
      return `${origin}/anthropic`;
    case "google-generative-ai":
      return `${origin}/genai/v1beta`;
  }
}
