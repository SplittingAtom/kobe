import type { IsolationGate } from "../isolation/gate.js";
import { loadSandboxConfig, type SandboxSettings, type SessionKeys } from "./config.js";
import { createKubeClient } from "./kube.js";
import { logger } from "../logger.js";
import { createSandboxProvider, type ReconcileResult, type SandboxProvider } from "./provider.js";

export const RECONCILE_INTERVAL_MS = 60_000;

export interface SandboxRuntime {
  /** Runs the isolation reconciler now and every minute; returns a stop function. */
  startReconciler(onResult: (result: ReconcileResult) => void): () => void;
  readonly provider: SandboxProvider;
  readonly sessionKeys: SessionKeys;
  readonly settings: SandboxSettings;
}

/**
 * The sandbox provider wired to the in-cluster API, or undefined when the chart did not configure
 * sandboxes (KOBE_SANDBOX_CONFIG unset). Invalid configuration throws (fail fast at startup).
 */
export function createSandboxRuntime(
  env: Readonly<Record<string, string | undefined>>,
  isolation: Pick<IsolationGate, "require">,
): SandboxRuntime | undefined {
  const config = loadSandboxConfig(env);
  if (!config) return undefined;
  const runtimeClassName = env.KOBE_RUNTIME_CLASS?.trim();
  const provider = createSandboxProvider({
    kube: createKubeClient(),
    isolation,
    settings: config.settings,
    ...(runtimeClassName ? { runtimeClassName } : {}),
  });
  return {
    provider,
    startReconciler(onResult) {
      let running = false;
      const run = () => {
        if (running) return;
        running = true;
        provider
          .reconcileIsolation()
          .then(onResult, (err: unknown) =>
            logger.warn({ err }, "sandbox isolation reconcile failed"),
          )
          .finally(() => {
            running = false;
          });
      };
      run();
      const timer = setInterval(run, RECONCILE_INTERVAL_MS);
      timer.unref();
      return () => clearInterval(timer);
    },
    sessionKeys: config.sessionKeys,
    settings: config.settings,
  };
}
