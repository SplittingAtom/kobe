import type { PiModelApi } from "@kobe/protocol";

/**
 * Model wiring for the Pi processes of this sandbox (KOBE-41): where the model gateway is, the
 * kobe-models extension to load, and the sandbox's rotating `kobe.model-gateway` session token.
 * Absent when the pod has no model gateway access (or the agent runs outside Kobe's pods): Pi then
 * has no provider and refuses prompts, as before KOBE-41.
 */
export interface ModelTokenSource {
  /** The current token (waits for the first trade). */
  current(): Promise<string>;
  /** Called with every new token; returns the unsubscribe function. */
  onChange(listener: (token: string) => void): () => void;
}

export interface ModelWiring {
  /** `KOBE_MODEL_GATEWAY_URL`: an http(s) origin, no credentials. */
  readonly gatewayUrl: string;
  /** The kobe-models extension file (root-owned, read-only). */
  readonly extension: string;
  readonly tokens: ModelTokenSource;
}

/** A run's model as the server resolved it from the catalog (`run.start.config.model`). */
export interface RunModel {
  readonly gatewayModel: string;
  readonly api: PiModelApi;
}
